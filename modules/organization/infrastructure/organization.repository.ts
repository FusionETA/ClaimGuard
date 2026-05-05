import "server-only"

import { hashPassword } from "@/lib/auth/password"
import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { mapChartAccount } from "@/modules/organization/infrastructure/chart-account.mapper"
import type {
  AdminOrganizationOption,
  AssignedProject,
  ChartOfAccountOption,
  EmployeePayoutMethod,
  LimitPeriod,
  LimitScope,
  MileageUnit,
  OrganizationMember,
  OrganizationProjectOption,
  OrganizationSummary,
  OtRates,
  TeamDetail,
  TeamMembership,
  TeamModuleConfig,
  TeamSummary,
  XeroConnectionInfo,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"
import {
  defaultModuleConfig,
  resolveAssignedProjects,
  resolveEmployeePayoutMethod,
  resolvePrimaryProjectName,
  trimModuleConfig,
  validateModuleConfig,
} from "@/modules/organization/domain/models"

const DEFAULT_OT_RATES: OtRates = {
  normalDay: 1.5,
  restDay: 2.0,
  publicHoliday: 3.0,
  restDayInShift: 1.0,
  publicHolidayInShift: 2.0,
  salaryThreshold: 4000,
}

export type XeroConnectionRecord = {
  id: string
  organizationId: string
  tenantId: string
  tenantName: string
  tenantType: string | null
  accessToken: string
  refreshToken: string
  scope: string
  tokenType: string
  accessTokenExpiresAt: Date
  createdAt: Date
  updatedAt: Date
}

// `toNumber` lives in `lib/decimal.ts` — re-aliased locally for the older
// callers below that pass a fallback positionally.
const toNumberOr = (value: unknown, fallback: number) => toNumber(value, fallback)

/// Compute the value to write into EmployeeProfile.hourlyRate based on
/// role + payout method. Throws if HOURLY is selected but the rate is
/// missing or non-positive. Returns null for SUPERVISOR / MONTHLY_BASED
/// (the field stays null in those cases).
///
/// Returns a string ("12.50") because Prisma's Decimal column accepts a
/// string and avoids float-rounding surprises.
function resolveHourlyRateForWrite(
  role: "EMPLOYEE" | "SUPERVISOR",
  payoutMethod: EmployeePayoutMethod,
  rate: number | null | undefined,
): string | null {
  const effective = resolveEmployeePayoutMethod(role, payoutMethod)
  if (effective !== "HOURLY") return null
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Hourly rate is required and must be greater than zero.")
  }
  return rate.toFixed(2)
}

function mapOrganizationSummary(
  org?:
    | {
        id: string
        name: string
        claimCutoffDay: number
        bankAccount?: string | null
        otRateNormalDay?: unknown
        otRateRestDay?: unknown
        otRatePublicHoliday?: unknown
        restDayInShiftRate?: unknown
        publicHolidayInShiftRate?: unknown
        otSalaryThreshold?: unknown
        otEnabled?: boolean | null
        defaultMileageRate?: unknown
        mileageUnit?: string | null
        geofenceRadiusMeters?: number | null
      }
    | null
): OrganizationSummary | undefined {
  if (!org) return undefined

  const rawDefaultMileageRate = org.defaultMileageRate
  const defaultMileageRate =
    rawDefaultMileageRate == null
      ? undefined
      : (() => {
          const n = Number(rawDefaultMileageRate as { toString(): string })
          return Number.isFinite(n) ? n : undefined
        })()

  return {
    id: org.id,
    name: org.name,
    claimCutoffDay: org.claimCutoffDay,
    bankAccount: org.bankAccount ?? undefined,
    otRates: {
      normalDay: toNumberOr(org.otRateNormalDay, DEFAULT_OT_RATES.normalDay),
      restDay: toNumberOr(org.otRateRestDay, DEFAULT_OT_RATES.restDay),
      publicHoliday: toNumberOr(org.otRatePublicHoliday, DEFAULT_OT_RATES.publicHoliday),
      restDayInShift: toNumberOr(org.restDayInShiftRate, DEFAULT_OT_RATES.restDayInShift),
      publicHolidayInShift: toNumberOr(
        org.publicHolidayInShiftRate,
        DEFAULT_OT_RATES.publicHolidayInShift
      ),
      salaryThreshold: toNumberOr(org.otSalaryThreshold, DEFAULT_OT_RATES.salaryThreshold),
    },
    otEnabled: org.otEnabled ?? true,
    defaultMileageRate,
    mileageUnit: (org.mileageUnit as MileageUnit | null | undefined) === "MILE" ? "MILE" : "KM",
    geofenceRadiusMeters: org.geofenceRadiusMeters ?? 200,
  }
}

function mapAssignedProjects(
  legacyProject: string | null | undefined,
  assignments: Array<{ project: { id: string; name: string } }> = [],
): AssignedProject[] {
  return resolveAssignedProjects(
    legacyProject,
    assignments.map((assignment) => assignment.project),
  )
}

export const organizationRepository = {
  async getOrganizationById(organizationId: string): Promise<OrganizationSummary | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.organization.findUnique({
      where: { id: organizationId },
    })

    return mapOrganizationSummary(row) ?? null
  },

  // ---------------------------------------------------------------------------
  // Admin multi-company
  // ---------------------------------------------------------------------------

  async getAdminOrganizations(adminId: string): Promise<AdminOrganizationOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const [admin, rows, xeroConnectedRows] = await Promise.all([
      prisma.user.findUnique({
        where: { id: adminId },
        select: {
          organization: {
            select: { id: true, name: true },
          },
        },
      }),
      prisma.adminOrganization.findMany({
        where: { adminId },
        include: { organization: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.xeroConnection.findMany({
        where: { connectedByAdminId: adminId },
        select: {
          organization: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
    ])

    const options: AdminOrganizationOption[] = []
    const seenOrganizationIds = new Set<string>()
    const recoveredOrganizationIds = new Set<string>()

    if (admin?.organization) {
      options.push({
        id: admin.organization.id,
        name: admin.organization.name,
      })
      seenOrganizationIds.add(admin.organization.id)
    }

    for (const row of rows) {
      if (seenOrganizationIds.has(row.organization.id)) continue

      options.push({
        id: row.organization.id,
        name: row.organization.name,
      })
      seenOrganizationIds.add(row.organization.id)
    }

    for (const row of xeroConnectedRows) {
      const organization = row.organization
      if (!organization || seenOrganizationIds.has(organization.id)) continue

      options.push({
        id: organization.id,
        name: organization.name,
      })
      seenOrganizationIds.add(organization.id)
      recoveredOrganizationIds.add(organization.id)
    }

    if (recoveredOrganizationIds.size > 0) {
      await Promise.all(
        Array.from(recoveredOrganizationIds).map((organizationId) =>
          prisma.adminOrganization.upsert({
            where: {
              adminId_organizationId: {
                adminId,
                organizationId,
              },
            },
            create: { adminId, organizationId },
            update: {},
          })
        )
      )
    }

    return options
  },

  async createAdminOrganization(data: {
    adminId: string
    name: string
  }): Promise<AdminOrganizationOption> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const admin = await prisma.user.findUnique({
      where: { id: data.adminId },
      select: { role: true, organizationId: true },
    })

    if (!admin || admin.role !== "ADMIN") {
      throw new Error("Admin account not found.")
    }

    const existing = await prisma.organization.findUnique({
      where: { name: data.name.trim() },
      select: { id: true },
    })

    if (existing) {
      throw new Error("An organization with that name already exists.")
    }

    const org = await prisma.organization.create({
      data: { name: data.name.trim() },
    })

    await prisma.adminOrganization.create({
      data: { adminId: data.adminId, organizationId: org.id },
    })

    if (!admin.organizationId) {
      await prisma.user.update({
        where: { id: data.adminId },
        data: { organizationId: org.id },
      })
    }

    return { id: org.id, name: org.name }
  },

  async linkAdminToOrganization(adminId: string, organizationId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.adminOrganization.upsert({
      where: { adminId_organizationId: { adminId, organizationId } },
      create: { adminId, organizationId },
      update: {},
    })
  },

  async isAdminOfOrganization(adminId: string, organizationId: string): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    const row = await prisma.adminOrganization.findUnique({
      where: { adminId_organizationId: { adminId, organizationId } },
    })

    if (row) {
      return true
    }

    const admin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { role: true, organizationId: true },
    })

    if (admin?.role === "ADMIN" && admin.organizationId === organizationId) {
      return true
    }

    const xeroConnection = await prisma.xeroConnection.findFirst({
      where: {
        organizationId,
        connectedByAdminId: adminId,
      },
      select: { id: true },
    })

    if (!xeroConnection) {
      return false
    }

    await prisma.adminOrganization.upsert({
      where: { adminId_organizationId: { adminId, organizationId } },
      create: { adminId, organizationId },
      update: {},
    })

    return true
  },

  async upsertAdminOrganization(data: {
    adminUserId: string
    organizationName: string
  }): Promise<OrganizationSummary> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const organizationName = data.organizationName.trim()
    const admin = await prisma.user.findUnique({
      where: { id: data.adminUserId },
      select: { organizationId: true, role: true },
    })

    if (!admin || admin.role !== "ADMIN") {
      throw new Error("Admin account not found.")
    }

    if (admin.organizationId) {
      const existingWithName = await prisma.organization.findUnique({
        where: { name: organizationName },
        select: { id: true },
      })

      if (existingWithName && existingWithName.id !== admin.organizationId) {
        throw new Error("That organization name is already being used by another organization.")
      }

      const organization = await prisma.organization.update({
        where: { id: admin.organizationId },
        data: { name: organizationName },
      })

      await prisma.adminOrganization.upsert({
        where: {
          adminId_organizationId: {
            adminId: data.adminUserId,
            organizationId: organization.id,
          },
        },
        create: {
          adminId: data.adminUserId,
          organizationId: organization.id,
        },
        update: {},
      })

      return mapOrganizationSummary(organization)!
    }

    const existing = await prisma.organization.findUnique({
      where: { name: organizationName },
      select: { id: true },
    })

    if (existing) {
      throw new Error("That organization name is already being used by another organization.")
    }

    const organization = await prisma.organization.create({
      data: {
        name: organizationName,
      },
    })

    await prisma.user.update({
      where: { id: data.adminUserId },
      data: { organizationId: organization.id },
    })

    await prisma.adminOrganization.upsert({
      where: {
        adminId_organizationId: {
          adminId: data.adminUserId,
          organizationId: organization.id,
        },
      },
      create: {
        adminId: data.adminUserId,
        organizationId: organization.id,
      },
      update: {},
    })

    return mapOrganizationSummary(organization)!
  },

  async updateOrganizationName(data: {
    adminId: string
    organizationId: string
    organizationName: string
  }): Promise<OrganizationSummary> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const isAdmin = await this.isAdminOfOrganization(data.adminId, data.organizationId)
    if (!isAdmin) {
      throw new Error("You do not have access to update this organization.")
    }

    const organizationName = data.organizationName.trim()
    const existingWithName = await prisma.organization.findUnique({
      where: { name: organizationName },
      select: { id: true },
    })

    if (existingWithName && existingWithName.id !== data.organizationId) {
      throw new Error("That organization name is already being used by another organization.")
    }

    const organization = await prisma.organization.update({
      where: { id: data.organizationId },
      data: { name: organizationName },
    })

    return mapOrganizationSummary(organization)!
  },

  async updateOrganizationBankAccount(data: {
    organizationId: string
    bankAccount: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.organization.update({
      where: { id: data.organizationId },
      data: { bankAccount: data.bankAccount },
    })
  },

  async updateOrganizationOtRates(data: {
    organizationId: string
    rates: OtRates
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.organization.update({
      where: { id: data.organizationId },
      data: {
        otRateNormalDay: data.rates.normalDay,
        otRateRestDay: data.rates.restDay,
        otRatePublicHoliday: data.rates.publicHoliday,
        restDayInShiftRate: data.rates.restDayInShift,
        publicHolidayInShiftRate: data.rates.publicHolidayInShift,
        otSalaryThreshold: data.rates.salaryThreshold,
      },
    })
  },

  async updateOrganizationClaimCutoff(data: {
    organizationId: string
    claimCutoffDay: number
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.organization.update({
      where: { id: data.organizationId },
      data: { claimCutoffDay: data.claimCutoffDay },
    })
  },

  async getOrganizationMembers(
    organizationId: string,
    xeroConnectionId?: string
  ): Promise<OrganizationMember[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.user.findMany({
      where: {
        organizationId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(xeroConnectionId
          ? { employeeProfile: { xeroConnectionId } }
          : {}),
      },
      include: {
        organization: true,
        employeeProfile: {
          include: {
            projectAssignments: {
              include: {
                project: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            supervisor: true,
            xeroConnection: { select: { id: true, tenantName: true } },
            teamMemberships: {
              include: {
                team: {
                  select: {
                    id: true,
                    name: true,
                    projectId: true,
                    project: { select: { id: true, name: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
        approvalChainSteps: {
          include: { approver: { select: { id: true, name: true } } },
          orderBy: [{ teamId: "asc" }, { step: "asc" }],
        },
      },
      orderBy: { name: "asc" },
    })

    return rows.map((user) => {
      const supervisorId = user.employeeProfile?.supervisorId ?? undefined
      const supervisorName = user.employeeProfile?.supervisor?.name ?? undefined
      const assignedProjects = mapAssignedProjects(
        user.employeeProfile?.project,
        user.employeeProfile?.projectAssignments ?? [],
      )

      // Build per-team chain map, grouped by step (multi-approver).
      // Each chain row's teamId tells us which team it belongs to; legacy
      // rows with teamId=null are dropped from the per-team view.
      // Within a team, group by `step` so {step, approvers[]} is the
      // shape we expose to the UI.
      const chainsByTeam = new Map<
        string,
        Map<number, Array<{ approverId: string; approverName: string }>>
      >()
      for (const s of user.approvalChainSteps) {
        if (!s.teamId) continue
        const stepMap = chainsByTeam.get(s.teamId) ?? new Map()
        const approvers = stepMap.get(s.step) ?? []
        approvers.push({ approverId: s.approverId, approverName: s.approver.name })
        stepMap.set(s.step, approvers)
        chainsByTeam.set(s.teamId, stepMap)
      }

      const teams = (user.employeeProfile?.teamMemberships ?? []).map(
        (membership) => {
          const stepMap = chainsByTeam.get(membership.teamId) ?? new Map()
          const stepNumbers = Array.from(stepMap.keys()).sort((a, b) => a - b)
          const chain = stepNumbers.map((step) => ({
            step,
            approvers: stepMap.get(step) ?? [],
          }))
          return {
            membershipId: membership.id,
            teamId: membership.teamId,
            teamName: membership.team.name,
            projectId: membership.team.projectId,
            projectName: membership.team.project.name,
            layer: membership.layer,
            chain,
          }
        },
      )

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role as OrganizationMember["role"],
        organizationId: user.organizationId ?? undefined,
        organizationName: user.organization?.name ?? undefined,
        employeeId: user.employeeProfile?.employeeId ?? "N/A",
        project: resolvePrimaryProjectName(
          user.employeeProfile?.project,
          user.employeeProfile?.projectAssignments?.map((assignment) => assignment.project) ?? [],
        ),
        projects: assignedProjects,
        jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
        payoutMethod: resolveEmployeePayoutMethod(
          user.role as OrganizationMember["role"],
          user.employeeProfile?.payoutMethod,
        ),
        hourlyRate:
          user.employeeProfile?.hourlyRate != null
            ? toNumber(user.employeeProfile.hourlyRate)
            : undefined,
        supervisorId,
        supervisorName,
        xeroConnectionId: user.employeeProfile?.xeroConnectionId ?? undefined,
        xeroConnectionName: user.employeeProfile?.xeroConnection?.tenantName ?? undefined,
        teams,
      }
    })
  },

  async updateOrganizationMember(data: {
    userId: string
    role: "EMPLOYEE" | "SUPERVISOR"
    organizationId: string
    projectIds: string[]
    jobTitle: string
    payoutMethod: EmployeePayoutMethod
    /// Required (positive number) when payoutMethod is HOURLY. Null /
    /// undefined OK for MONTHLY_BASED. When the role flips to SUPERVISOR
    /// or payoutMethod flips to MONTHLY_BASED, the rate is cleared.
    hourlyRate?: number | null
    xeroConnectionId?: string
    /// One entry per project the employee should belong to. When provided
    /// (even as []), the employee's team memberships and chain rows are
    /// rewritten from scratch to match. When undefined, those tables are
    /// left untouched.
    projectAssignments?: Array<{
      projectId: string
      teamId: string
      layer: number
      chainApprovers: Array<{ layer: number; userId: string }>
    }>
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    const targetUser = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { organizationId: true, role: true },
    })

    if (
      !targetUser ||
      targetUser.role === "ADMIN" ||
      targetUser.organizationId !== data.organizationId
    ) {
      throw new Error("You can only manage members inside your own organization.")
    }

    if (data.xeroConnectionId) {
      const xeroConnection = await prisma.xeroConnection.findUnique({
        where: { id: data.xeroConnectionId },
        select: { organizationId: true },
      })

      if (!xeroConnection || xeroConnection.organizationId !== data.organizationId) {
        throw new Error("Xero connection must belong to this organization.")
      }
    }

    const assignedProjects = data.projectIds.length
      ? await prisma.xeroProject.findMany({
          where: {
            id: { in: data.projectIds },
            organizationId: data.organizationId,
            ...(data.xeroConnectionId
              ? {
                  OR: [
                    { xeroConnectionId: data.xeroConnectionId },
                    { xeroConnectionId: null },
                  ],
                }
              : {}),
          },
          select: { id: true, name: true },
        })
      : []

    if (assignedProjects.length !== data.projectIds.length) {
      throw new Error("Selected projects must belong to this organization.")
    }

    const assignedProjectById = new Map(assignedProjects.map((project) => [project.id, project]))
    const primaryProjectName = data.projectIds
      .map((projectId) => assignedProjectById.get(projectId)?.name)
      .find(Boolean) ?? ""

    // Validate per-project assignments if provided.
    type ValidatedAssignment = {
      projectId: string
      teamId: string
      layer: number
      sortedChain: Array<{ layer: number; userId: string }>
      lowestLayerApproverId: string | null
    }
    let validatedAssignments: ValidatedAssignment[] | undefined
    if (data.projectAssignments !== undefined) {
      validatedAssignments = []
      const teamIds = Array.from(
        new Set(data.projectAssignments.map((a) => a.teamId)),
      )
      const teams = teamIds.length
        ? await prisma.team.findMany({
            where: { id: { in: teamIds } },
            select: { id: true, projectId: true, layerCount: true },
          })
        : []
      const teamById = new Map(teams.map((t) => [t.id, t]))

      const allApproverIds = Array.from(
        new Set(
          data.projectAssignments
            .flatMap((a) => a.chainApprovers.map((c) => c.userId))
            .filter(Boolean),
        ),
      )
      const approvers = allApproverIds.length
        ? await prisma.user.findMany({
            where: { id: { in: allApproverIds } },
            select: { id: true, organizationId: true, role: true },
          })
        : []
      const approverById = new Map(approvers.map((a) => [a.id, a]))

      const memberships = teamIds.length && allApproverIds.length
        ? await prisma.employeeTeamMembership.findMany({
            where: {
              teamId: { in: teamIds },
              employeeProfile: { userId: { in: allApproverIds } },
            },
            select: {
              teamId: true,
              layer: true,
              employeeProfile: { select: { userId: true } },
            },
          })
        : []
      const layerByTeamUser = new Map(
        memberships.map((m) => [`${m.teamId}:${m.employeeProfile.userId}`, m.layer]),
      )

      for (const a of data.projectAssignments) {
        const team = teamById.get(a.teamId)
        if (!team) throw new Error("Team not found.")
        if (team.projectId !== a.projectId) {
          throw new Error("Team does not belong to the chosen project.")
        }
        if (!data.projectIds.includes(a.projectId)) {
          throw new Error("Project must be one of the assigned projects.")
        }
        if (a.layer < 1 || a.layer > team.layerCount) {
          throw new Error(
            `Layer must be between 1 and ${team.layerCount} for this team.`,
          )
        }
        const sortedChain = [...a.chainApprovers].sort(
          (x, y) => x.layer - y.layer,
        )
        for (const c of sortedChain) {
          const u = approverById.get(c.userId)
          if (!u || u.organizationId !== data.organizationId) {
            throw new Error("All chain approvers must belong to your organization.")
          }
          if (u.role !== "SUPERVISOR" && u.role !== "ADMIN") {
            throw new Error("Chain approvers must be supervisors or admins.")
          }
          const layer = layerByTeamUser.get(`${a.teamId}:${c.userId}`)
          if (layer === undefined || layer !== c.layer) {
            throw new Error(
              `Selected approver is not a layer-${c.layer} member of this team.`,
            )
          }
        }
        validatedAssignments.push({
          projectId: a.projectId,
          teamId: a.teamId,
          layer: a.layer,
          sortedChain,
          lowestLayerApproverId: sortedChain[0]?.userId ?? null,
        })
      }
    }

    const profile = await prisma.employeeProfile.findUnique({
      where: { userId: data.userId },
      select: { id: true },
    })
    if (!profile) throw new Error("Employee profile not found.")

    // Pick a deterministic supervisorId for legacy callers (alphabetically-
    // first project's lowest-layer approver). Only updated when assignments
    // are explicitly being rewritten.
    let supervisorIdForProfile: string | null | undefined
    if (validatedAssignments !== undefined) {
      if (validatedAssignments.length === 0) {
        supervisorIdForProfile = null
      } else {
        const byProject = [...validatedAssignments].sort((x, y) => {
          const xName = assignedProjectById.get(x.projectId)?.name ?? ""
          const yName = assignedProjectById.get(y.projectId)?.name ?? ""
          return xName.localeCompare(yName)
        })
        supervisorIdForProfile = byProject[0]!.lowestLayerApproverId
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: data.userId },
        data: { role: data.role, organizationId: data.organizationId },
      })
      await tx.employeeProfile.update({
        where: { userId: data.userId },
        data: {
          project: primaryProjectName,
          jobTitle: data.jobTitle,
          payoutMethod: resolveEmployeePayoutMethod(data.role, data.payoutMethod),
          hourlyRate: resolveHourlyRateForWrite(
            data.role,
            data.payoutMethod,
            data.hourlyRate,
          ),
          xeroConnectionId: data.xeroConnectionId || null,
          ...(supervisorIdForProfile !== undefined
            ? { supervisorId: supervisorIdForProfile }
            : {}),
        },
      })
      await tx.employeeProjectAssignment.deleteMany({
        where: { employeeProfile: { userId: data.userId } },
      })
      for (const projectId of data.projectIds) {
        await tx.employeeProjectAssignment.create({
          data: {
            employeeProfile: { connect: { userId: data.userId } },
            project: { connect: { id: projectId } },
          },
        })
      }

      // Rewrite team memberships + chain rows when assignments were
      // explicitly provided (even as []).
      if (validatedAssignments !== undefined) {
        await tx.employeeTeamMembership.deleteMany({
          where: { employeeProfileId: profile.id },
        })
        await tx.approvalChainStep.deleteMany({
          where: { employeeId: data.userId },
        })
        for (const a of validatedAssignments) {
          await tx.employeeTeamMembership.create({
            data: {
              employeeProfileId: profile.id,
              teamId: a.teamId,
              layer: a.layer,
            },
          })
          if (a.sortedChain.length > 0) {
            // Step numbers based on unique layers, not array index, so
            // multiple approvers at the same layer share one step.
            const layerToStep = new Map<number, number>()
            let stepCounter = 0
            for (const c of a.sortedChain) {
              if (!layerToStep.has(c.layer)) {
                stepCounter += 1
                layerToStep.set(c.layer, stepCounter)
              }
            }
            await tx.approvalChainStep.createMany({
              data: a.sortedChain.map((c) => ({
                employeeId: data.userId,
                teamId: a.teamId,
                approverId: c.userId,
                step: layerToStep.get(c.layer)!,
              })),
            })
          }
        }
      }
    })

    return true
  },

  async createOrganizationMember(data: {
    name: string
    email: string
    password: string
    employeeId: string
    role: "EMPLOYEE" | "SUPERVISOR"
    organizationId: string
    projectIds: string[]
    jobTitle: string
    payoutMethod: EmployeePayoutMethod
    /// Required (positive number) when payoutMethod is HOURLY. Ignored
    /// otherwise — supervisors and MONTHLY_BASED employees don't carry
    /// an hourly rate.
    hourlyRate?: number | null
    xeroConnectionId?: string
    /// One entry per project the employee belongs to. Each entry pins the
    /// employee to a team in that project at a specific layer, plus an
    /// explicit per-layer chain (one approver per layer above the
    /// employee). Required when the employee is in any project (i.e.
    /// projectIds is non-empty); empty allowed for super-edge-cases like
    /// admins without project assignments.
    projectAssignments?: Array<{
      projectId: string
      teamId: string
      layer: number
      chainApprovers: Array<{ layer: number; userId: string }>
    }>
  }): Promise<{ id: string }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    })

    if (existingUser) {
      throw new Error("That email is already being used by another account.")
    }

    const existingEmployeeProfile = await prisma.employeeProfile.findUnique({
      where: { employeeId: data.employeeId },
      select: { id: true },
    })

    if (existingEmployeeProfile) {
      throw new Error("That employee ID is already assigned to another user.")
    }

    if (data.xeroConnectionId) {
      const xeroConnection = await prisma.xeroConnection.findUnique({
        where: { id: data.xeroConnectionId },
        select: { organizationId: true },
      })

      if (!xeroConnection || xeroConnection.organizationId !== data.organizationId) {
        throw new Error("Xero connection must belong to this organization.")
      }
    }

    const assignedProjects = data.projectIds.length
      ? await prisma.xeroProject.findMany({
          where: {
            id: { in: data.projectIds },
            organizationId: data.organizationId,
            ...(data.xeroConnectionId
              ? {
                  OR: [
                    { xeroConnectionId: data.xeroConnectionId },
                    { xeroConnectionId: null },
                  ],
                }
              : {}),
          },
          select: { id: true, name: true },
        })
      : []

    if (assignedProjects.length !== data.projectIds.length) {
      throw new Error("Selected projects must belong to this organization.")
    }

    const assignedProjectById = new Map(assignedProjects.map((project) => [project.id, project]))
    const primaryProjectName = data.projectIds
      .map((projectId) => assignedProjectById.get(projectId)?.name)
      .find(Boolean) ?? ""

    // Validate per-project assignments. Each must reference a project the
    // employee is assigned to, point at a real team in that project, and
    // every chain approver must be a member of that team at the claimed
    // layer.
    const validatedAssignments: Array<{
      projectId: string
      teamId: string
      layer: number
      sortedChain: Array<{ layer: number; userId: string }>
      lowestLayerApproverId: string | null
    }> = []
    if (data.projectAssignments && data.projectAssignments.length > 0) {
      const teamIds = Array.from(
        new Set(data.projectAssignments.map((a) => a.teamId)),
      )
      const teams = await prisma.team.findMany({
        where: { id: { in: teamIds } },
        select: { id: true, projectId: true, layerCount: true },
      })
      const teamById = new Map(teams.map((t) => [t.id, t]))

      const allApproverIds = Array.from(
        new Set(
          data.projectAssignments
            .flatMap((a) => a.chainApprovers.map((c) => c.userId))
            .filter(Boolean),
        ),
      )
      const approvers = allApproverIds.length
        ? await prisma.user.findMany({
            where: { id: { in: allApproverIds } },
            select: { id: true, organizationId: true, role: true },
          })
        : []
      const approverById = new Map(approvers.map((a) => [a.id, a]))

      const memberships = teamIds.length
        ? await prisma.employeeTeamMembership.findMany({
            where: {
              teamId: { in: teamIds },
              employeeProfile: { userId: { in: allApproverIds } },
            },
            select: {
              teamId: true,
              layer: true,
              employeeProfile: { select: { userId: true } },
            },
          })
        : []
      const layerByTeamUser = new Map(
        memberships.map((m) => [`${m.teamId}:${m.employeeProfile.userId}`, m.layer]),
      )

      for (const a of data.projectAssignments) {
        const team = teamById.get(a.teamId)
        if (!team) throw new Error("Team not found.")
        if (team.projectId !== a.projectId) {
          throw new Error("Team does not belong to the chosen project.")
        }
        if (!data.projectIds.includes(a.projectId)) {
          throw new Error("Project must be one of the assigned projects.")
        }
        if (a.layer < 1 || a.layer > team.layerCount) {
          throw new Error(
            `Layer must be between 1 and ${team.layerCount} for this team.`,
          )
        }
        const sortedChain = [...a.chainApprovers].sort(
          (x, y) => x.layer - y.layer,
        )
        for (const c of sortedChain) {
          const u = approverById.get(c.userId)
          if (!u || u.organizationId !== data.organizationId) {
            throw new Error("All chain approvers must belong to your organization.")
          }
          if (u.role !== "SUPERVISOR" && u.role !== "ADMIN") {
            throw new Error("Chain approvers must be supervisors or admins.")
          }
          const layer = layerByTeamUser.get(`${a.teamId}:${c.userId}`)
          if (layer === undefined || layer !== c.layer) {
            throw new Error(
              `Selected approver is not a layer-${c.layer} member of this team.`,
            )
          }
        }
        validatedAssignments.push({
          projectId: a.projectId,
          teamId: a.teamId,
          layer: a.layer,
          sortedChain,
          lowestLayerApproverId: sortedChain[0]?.userId ?? null,
        })
      }
    }

    // Pick a representative supervisor pointer for legacy callers reading
    // EmployeeProfile.supervisorId. Use the lowest-layer approver from the
    // alphabetically-first project (so the value is deterministic).
    const supervisorIdForProfile = (() => {
      if (validatedAssignments.length === 0) return null
      const byProject = [...validatedAssignments].sort((x, y) => {
        const xName = assignedProjectById.get(x.projectId)?.name ?? ""
        const yName = assignedProjectById.get(y.projectId)?.name ?? ""
        return xName.localeCompare(yName)
      })
      return byProject[0]!.lowestLayerApproverId
    })()

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash: hashPassword(data.password),
        role: data.role,
        organizationId: data.organizationId,
        employeeProfile: {
          create: {
            employeeId: data.employeeId,
            project: primaryProjectName,
            jobTitle: data.jobTitle,
            supervisorId: supervisorIdForProfile,
            payoutMethod: resolveEmployeePayoutMethod(data.role, data.payoutMethod),
            hourlyRate: resolveHourlyRateForWrite(data.role, data.payoutMethod, data.hourlyRate),
            preferredCurrency: "USD",
            xeroConnectionId: data.xeroConnectionId || null,
            projectAssignments: {
              create: data.projectIds.map((projectId) => ({
                project: { connect: { id: projectId } },
              })),
            },
            ...(validatedAssignments.length > 0
              ? {
                  teamMemberships: {
                    create: validatedAssignments.map((a) => ({
                      teamId: a.teamId,
                      layer: a.layer,
                    })),
                  },
                }
              : {}),
          },
        },
      },
      select: { id: true },
    })

    // Write per-team chain rows. Each project's chain is independent.
    // Multiple approvers per layer share a single step number — they're
    // any-of approvers (any one approves → step is done). Step numbers
    // are assigned in layer order (1-indexed, skipping the employee's
    // own layer).
    for (const a of validatedAssignments) {
      if (a.sortedChain.length === 0) continue
      const layerToStep = new Map<number, number>()
      let stepCounter = 0
      for (const c of a.sortedChain) {
        if (!layerToStep.has(c.layer)) {
          stepCounter += 1
          layerToStep.set(c.layer, stepCounter)
        }
      }
      await prisma.approvalChainStep.createMany({
        data: a.sortedChain.map((c) => ({
          employeeId: user.id,
          teamId: a.teamId,
          approverId: c.userId,
          step: layerToStep.get(c.layer)!,
        })),
      })
    }

    return { id: user.id }
  },

  async setApprovalChain(data: {
    employeeId: string
    organizationId: string
    approverIds: string[]
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    // Verify the employee belongs to this org
    const employee = await prisma.user.findUnique({
      where: { id: data.employeeId },
      select: { organizationId: true, role: true },
    })

    if (!employee || employee.organizationId !== data.organizationId) {
      throw new Error("Employee not found in this organization.")
    }

    // Validate all proposed approvers belong to the org and are SUPERVISOR role
    if (data.approverIds.length > 0) {
      const approvers = await prisma.user.findMany({
        where: { id: { in: data.approverIds } },
        select: { id: true, organizationId: true, role: true },
      })

      for (const approver of approvers) {
        if (approver.organizationId !== data.organizationId) {
          throw new Error("All approvers must belong to the same organization.")
        }
        if (approver.role !== "SUPERVISOR" && approver.role !== "ADMIN") {
          throw new Error("Approvers must be supervisors or admins.")
        }
      }

      if (approvers.length !== data.approverIds.length) {
        throw new Error("One or more approvers could not be found.")
      }
    }

    // First approver in the chain is also the direct supervisor — keep
    // employeeProfile.supervisorId in sync so callers reading it stay correct.
    const newSupervisorId = data.approverIds[0] ?? null

    await prisma.$transaction([
      prisma.approvalChainStep.deleteMany({ where: { employeeId: data.employeeId } }),
      ...data.approverIds.map((approverId, index) =>
        prisma.approvalChainStep.create({
          data: {
            employeeId: data.employeeId,
            approverId,
            step: index + 1,
          },
        })
      ),
      prisma.employeeProfile.update({
        where: { userId: data.employeeId },
        data: { supervisorId: newSupervisorId },
      }),
    ])
  },

  // ---------------------------------------------------------------------------
  // XeroConnection queries
  // ---------------------------------------------------------------------------

  async getXeroConnections(organizationId: string): Promise<XeroConnectionInfo[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.xeroConnection.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        tenantId: true,
        tenantName: true,
        tenantType: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      tenantType: row.tenantType ?? undefined,
      connectedAt: row.createdAt.toISOString(),
      lastTokenRefreshAt: row.updatedAt.toISOString(),
    }))
  },

  async getXeroConnectionById(connectionId: string): Promise<XeroConnectionRecord | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    return prisma.xeroConnection.findUnique({
      where: { id: connectionId },
    })
  },

  async getXeroConnectionSummary(organizationId: string): Promise<XeroConnectionSummary | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const rows = await prisma.xeroConnection.findMany({
      where: { organizationId },
      select: {
        id: true,
        tenantId: true,
        tenantName: true,
        tenantType: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    })

    return {
      configured: true,
      missingConfig: [],
      connections: rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        tenantType: row.tenantType ?? undefined,
        connectedAt: row.createdAt.toISOString(),
        lastTokenRefreshAt: row.updatedAt.toISOString(),
      })),
    }
  },

  async upsertXeroConnection(data: {
    organizationId: string
    tenantId: string
    tenantName: string
    tenantType?: string
    accessToken: string
    refreshToken: string
    scope: string
    tokenType: string
    accessTokenExpiresAt: Date
    connectedByAdminId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.adminOrganization.upsert({
      where: {
        adminId_organizationId: {
          adminId: data.connectedByAdminId,
          organizationId: data.organizationId,
        },
      },
      create: {
        adminId: data.connectedByAdminId,
        organizationId: data.organizationId,
      },
      update: {},
    })

    await prisma.xeroConnection.upsert({
      where: {
        organizationId_tenantId: {
          organizationId: data.organizationId,
          tenantId: data.tenantId,
        },
      },
      create: {
        provider: "xero",
        organizationId: data.organizationId,
        tenantId: data.tenantId,
        tenantName: data.tenantName,
        tenantType: data.tenantType,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        connectedByAdminId: data.connectedByAdminId,
      },
      update: {
        tenantName: data.tenantName,
        tenantType: data.tenantType,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        connectedByAdminId: data.connectedByAdminId,
      },
    })
  },

  /**
   * Updates tokens only if the refresh token in the DB still matches `oldRefreshToken`.
   * Uses connectionId (the connection's own primary key) as the where key.
   * Returns true if the update was applied.
   */
  async updateXeroConnectionTokensIfMatch(data: {
    connectionId: string
    oldRefreshToken: string
    accessToken: string
    refreshToken: string
    scope: string
    tokenType: string
    accessTokenExpiresAt: Date
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const result = await prisma.xeroConnection.updateMany({
      where: {
        id: data.connectionId,
        refreshToken: data.oldRefreshToken,
      },
      data: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
      },
    })

    return result.count > 0
  },

  async deleteXeroConnection(data: {
    connectionId: string
    organizationId: string
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    const result = await prisma.xeroConnection.deleteMany({
      where: {
        id: data.connectionId,
        organizationId: data.organizationId,
      },
    })

    return result.count > 0
  },

  // ---------------------------------------------------------------------------
  // Chart of Accounts
  // ---------------------------------------------------------------------------

  async getChartAccountsForConnection(xeroConnectionId: string): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { xeroConnectionId, isDisabled: false },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getSelectableChartAccountsForEmployee(data: {
    organizationId: string
    xeroConnectionId?: string
  }): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    if (data.xeroConnectionId) {
      // Employee assigned to a Xero connection — return selectable accounts for that connection
      const rows = await prisma.chartOfAccount.findMany({
        where: {
          xeroConnectionId: data.xeroConnectionId,
          isSelectable: true,
          isDisabled: false,
        },
        orderBy: [{ code: "asc" }, { name: "asc" }],
      })
      return rows.map((row) => mapChartAccount(row)!)
    }

    // No Xero connection — return custom accounts (xeroConnectionId IS null) that are selectable
    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        xeroConnectionId: null,
        isSelectable: true,
        isDisabled: false,
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getSelectableChartAccountsForOrganization(
    organizationId: string
  ): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId,
        isSelectable: true,
        isDisabled: false,
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getChartAccountsForOrganization(organizationId: string): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId, isDisabled: false },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getCustomChartAccountsForOrganization(
    organizationId: string
  ): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId, xeroConnectionId: null, isDisabled: false },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getChartAccountByIdForOrganization(data: {
    organizationId: string
    chartOfAccountId: string
    /**
     * When "EXPENSE" (the default) the account must have isSelectable=true.
     * When "MILEAGE" the account must have allowMileageClaim=true (it may or
     * may not also be selectable for expenses).
     */
    forClaimType?: "EXPENSE" | "MILEAGE"
  }): Promise<ChartOfAccountOption | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const claimTypeWhere =
      data.forClaimType === "MILEAGE"
        ? { allowMileageClaim: true }
        : { isSelectable: true }

    const row = await prisma.chartOfAccount.findFirst({
      where: {
        id: data.chartOfAccountId,
        organizationId: data.organizationId,
        isDisabled: false,
        ...claimTypeWhere,
      },
    })

    return mapChartAccount(row) ?? null
  },

  async getMileageChartAccountsForEmployee(data: {
    organizationId: string
    xeroConnectionId?: string
  }): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    if (data.xeroConnectionId) {
      const rows = await prisma.chartOfAccount.findMany({
        where: {
          xeroConnectionId: data.xeroConnectionId,
          allowMileageClaim: true,
          isDisabled: false,
        },
        orderBy: [{ code: "asc" }, { name: "asc" }],
      })
      return rows.map((row) => mapChartAccount(row)!)
    }

    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        xeroConnectionId: null,
        allowMileageClaim: true,
        isDisabled: false,
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async createCustomChartAccount(data: {
    organizationId: string
    code: string
    name: string
    type?: string
    isSelectable: boolean
  }): Promise<ChartOfAccountOption> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const row = await prisma.chartOfAccount.create({
      data: {
        organizationId: data.organizationId,
        xeroConnectionId: null,
        xeroAccountId: null,
        code: data.code,
        name: data.name,
        type: data.type,
        isSelectable: data.isSelectable,
        isCustom: true,
      },
    })

    return mapChartAccount(row)!
  },

  async updateCustomChartAccount(data: {
    id: string
    organizationId: string
    code: string
    name: string
    type?: string
    isSelectable: boolean
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.chartOfAccount.updateMany({
      where: { id: data.id, organizationId: data.organizationId, isCustom: true },
      data: {
        code: data.code,
        name: data.name,
        type: data.type,
        isSelectable: data.isSelectable,
      },
    })
  },

  async deleteCustomChartAccount(data: {
    id: string
    organizationId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.chartOfAccount.deleteMany({
      where: { id: data.id, organizationId: data.organizationId, isCustom: true },
    })
  },

  async upsertChartAccountsFromXero(data: {
    xeroConnectionId: string
    organizationId: string
    accounts: Array<{
      xeroAccountId: string
      code: string
      name: string
      type?: string
      status?: string
    }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    // Additive sync — never delete, just upsert. Removed accounts stay in DB
    // so historical claim data (which references chartOfAccountId) stays intact.
    await Promise.all(
      data.accounts.map((account) =>
        prisma.chartOfAccount.upsert({
          where: {
            xeroConnectionId_xeroAccountId: {
              xeroConnectionId: data.xeroConnectionId,
              xeroAccountId: account.xeroAccountId,
            },
          },
          create: {
            organizationId: data.organizationId,
            xeroConnectionId: data.xeroConnectionId,
            xeroAccountId: account.xeroAccountId,
            code: account.code,
            name: account.name,
            type: account.type,
            status: account.status,
            isCustom: false,
            isDisabled: false,
          },
          update: {
            code: account.code,
            name: account.name,
            type: account.type,
            status: account.status,
          },
        })
      )
    )
  },

  async setSelectableChartAccounts(data: {
    organizationId: string
    xeroConnectionId?: string
    chartAccountIds: string[]
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const scopeWhere = data.xeroConnectionId
      ? { organizationId: data.organizationId, xeroConnectionId: data.xeroConnectionId }
      : { organizationId: data.organizationId, xeroConnectionId: null }

    await prisma.$transaction([
      prisma.chartOfAccount.updateMany({
        where: scopeWhere,
        data: { isSelectable: false },
      }),
      ...(data.chartAccountIds.length > 0
        ? [
            prisma.chartOfAccount.updateMany({
              where: {
                ...scopeWhere,
                id: { in: data.chartAccountIds },
              },
              data: { isSelectable: true },
            }),
          ]
        : []),
    ])
  },

  /**
   * Bulk-update which accounts are valid for Mileage claims, plus the
   * optional per-account mileage rate override. Accounts not present in
   * `selectedAccounts` get `allowMileageClaim` cleared.
   */
  async setMileageChartAccounts(data: {
    organizationId: string
    xeroConnectionId?: string
    selectedAccounts: Array<{ chartAccountId: string; mileageRate?: number }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const scopeWhere = data.xeroConnectionId
      ? { organizationId: data.organizationId, xeroConnectionId: data.xeroConnectionId }
      : { organizationId: data.organizationId, xeroConnectionId: null }

    const ops: Array<ReturnType<typeof prisma.chartOfAccount.updateMany>> = [
      prisma.chartOfAccount.updateMany({
        where: scopeWhere,
        data: { allowMileageClaim: false, mileageRate: null },
      }),
    ]

    for (const selection of data.selectedAccounts) {
      ops.push(
        prisma.chartOfAccount.updateMany({
          where: { ...scopeWhere, id: selection.chartAccountId },
          data: {
            allowMileageClaim: true,
            mileageRate:
              selection.mileageRate != null && Number.isFinite(selection.mileageRate)
                ? selection.mileageRate
                : null,
          },
        })
      )
    }

    await prisma.$transaction(ops)
  },

  /**
   * Update the spend-limit policy on a single account. Pass undefined values
   * to clear the limit entirely (limitAmount=null + limitPeriod=null + limitScope=null).
   */
  async updateChartAccountLimit(data: {
    organizationId: string
    chartOfAccountId: string
    limitAmount?: number
    limitPeriod?: LimitPeriod
    limitScope?: LimitScope
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const hasLimit =
      data.limitAmount != null &&
      Number.isFinite(data.limitAmount) &&
      data.limitAmount > 0 &&
      data.limitPeriod != null &&
      data.limitScope != null

    await prisma.chartOfAccount.updateMany({
      where: { id: data.chartOfAccountId, organizationId: data.organizationId },
      data: hasLimit
        ? {
            limitAmount: data.limitAmount,
            limitPeriod: data.limitPeriod,
            limitScope: data.limitScope,
          }
        : {
            limitAmount: null,
            limitPeriod: null,
            limitScope: null,
          },
    })
  },

  async updateOrganizationMileageDefaults(data: {
    organizationId: string
    defaultMileageRate?: number
    mileageUnit: MileageUnit
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.organization.update({
      where: { id: data.organizationId },
      data: {
        defaultMileageRate:
          data.defaultMileageRate != null && Number.isFinite(data.defaultMileageRate)
            ? data.defaultMileageRate
            : null,
        mileageUnit: data.mileageUnit,
      },
    })
  },

  // ---------------------------------------------------------------------------
  // Bank accounts
  // ---------------------------------------------------------------------------

  async getBankAccountsForOrganization(data: {
    organizationId: string
    xeroConnectionId?: string
  }): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        type: "BANK",
        isDisabled: false,
        ...(data.xeroConnectionId
          ? { xeroConnectionId: data.xeroConnectionId }
          : { xeroConnectionId: null }),
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getSelectedBankAccountsForOrganization(data: {
    organizationId: string
    xeroConnectionId?: string
  }): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        type: "BANK",
        isBankAccount: true,
        isDisabled: false,
        ...(data.xeroConnectionId
          ? { xeroConnectionId: data.xeroConnectionId }
          : { xeroConnectionId: null }),
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getSelectedBankAccountByIdForOrganization(data: {
    organizationId: string
    chartAccountId: string
  }): Promise<ChartOfAccountOption | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.chartOfAccount.findFirst({
      where: {
        id: data.chartAccountId,
        organizationId: data.organizationId,
        type: "BANK",
        isBankAccount: true,
        isDisabled: false,
      },
    })

    return row ? mapChartAccount(row)! : null
  },

  async setSelectedBankAccounts(data: {
    organizationId: string
    xeroConnectionId?: string
    chartAccountIds: string[]
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const scopeWhere = data.xeroConnectionId
      ? { organizationId: data.organizationId, xeroConnectionId: data.xeroConnectionId, type: "BANK" }
      : { organizationId: data.organizationId, xeroConnectionId: null, type: "BANK" }

    await prisma.$transaction([
      prisma.chartOfAccount.updateMany({
        where: scopeWhere,
        data: { isBankAccount: false },
      }),
      ...(data.chartAccountIds.length > 0
        ? [
            prisma.chartOfAccount.updateMany({
              where: { ...scopeWhere, id: { in: data.chartAccountIds } },
              data: { isBankAccount: true },
            }),
          ]
        : []),
    ])
  },

  // Disable all custom COA and projects when Xero is first connected
  async disableCustomRecordsOnXeroConnect(organizationId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.$transaction([
      prisma.chartOfAccount.updateMany({
        where: { organizationId, isCustom: true, isDisabled: false },
        data: { isDisabled: true },
      }),
      prisma.xeroProject.updateMany({
        where: { organizationId, isManual: true, isDisabled: false },
        data: { isDisabled: true },
      }),
    ])
  },

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  async getProjectsForConnection(xeroConnectionId: string): Promise<OrganizationProjectOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.xeroProject.findMany({
      where: { xeroConnectionId, isDisabled: false },
      include: {
        projectManager: { select: { id: true, name: true } },
        projectManagers: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ name: "asc" }],
    })

    return rows.map((row) => ({
      id: row.id,
      xeroProjectId: row.xeroProjectId ?? undefined,
      name: row.name,
      status: row.status ?? undefined,
      contactId: row.contactId ?? undefined,
      xeroConnectionId: row.xeroConnectionId ?? undefined,
      projectManagerId: row.projectManagerId ?? undefined,
      projectManagerName: row.projectManager?.name ?? undefined,
      projectManagers: row.projectManagers.map((pm) => ({
        userId: pm.user.id,
        name: pm.user.name,
      })),
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      isManual: row.isManual,
    }))
  },

  async getProjectsForOrganization(organizationId: string): Promise<OrganizationProjectOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.xeroProject.findMany({
      where: { organizationId, isDisabled: false },
      include: {
        projectManager: { select: { id: true, name: true } },
        projectManagers: {
          include: { user: { select: { id: true, name: true } } },
        },
        holidays: { orderBy: { date: "asc" } },
      },
      orderBy: [{ name: "asc" }],
    })

    return rows.map((row) => ({
      id: row.id,
      xeroProjectId: row.xeroProjectId ?? undefined,
      name: row.name,
      status: row.status ?? undefined,
      contactId: row.contactId ?? undefined,
      xeroConnectionId: row.xeroConnectionId ?? undefined,
      projectManagerId: row.projectManagerId ?? undefined,
      projectManagerName: row.projectManager?.name ?? undefined,
      projectManagers: row.projectManagers.map((pm) => ({
        userId: pm.user.id,
        name: pm.user.name,
      })),
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      isManual: row.isManual,
      workingHoursStart: row.workingHoursStart,
      workingHoursEnd: row.workingHoursEnd,
      workingDays: row.workingDays,
      holidays: row.holidays.map((h) => ({
        id: h.id,
        date: h.date.toISOString().slice(0, 10),
        name: h.name,
      })),
    }))
  },

  async createManualProject(data: {
    organizationId: string
    name: string
    /// Multiple project managers, written into the ProjectManager join
    /// table. Each must be a SUPERVISOR or ADMIN in the same organization.
    projectManagerIds?: string[]
    location?: string
    latitude?: number
    longitude?: number
  }): Promise<OrganizationProjectOption> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const pmIds = Array.from(new Set(data.projectManagerIds ?? [])).filter(Boolean)
    if (pmIds.length > 0) {
      const pms = await prisma.user.findMany({
        where: { id: { in: pmIds } },
        select: { id: true, organizationId: true, role: true },
      })
      if (pms.length !== pmIds.length) {
        throw new Error("One or more project managers were not found.")
      }
      for (const pm of pms) {
        if (pm.organizationId !== data.organizationId) {
          throw new Error("Project managers must belong to this organization.")
        }
        if (pm.role !== "SUPERVISOR" && pm.role !== "ADMIN") {
          throw new Error("Project managers must be SUPERVISOR or ADMIN.")
        }
      }
    }

    const row = await prisma.xeroProject.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        // Keep the legacy single-PM column in sync with the first picked
        // PM so older readers still see something. Eventually this column
        // will be dropped when no callers need it.
        projectManagerId: pmIds[0] ?? null,
        location: data.location || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        isManual: true,
        projectManagers: {
          create: pmIds.map((userId) => ({ userId })),
        },
      },
      include: {
        projectManager: { select: { id: true, name: true } },
        projectManagers: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
    })

    return {
      id: row.id,
      name: row.name,
      projectManagerId: row.projectManagerId ?? undefined,
      projectManagerName: row.projectManager?.name ?? undefined,
      projectManagers: row.projectManagers.map((pm) => ({
        userId: pm.user.id,
        name: pm.user.name,
      })),
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      isManual: true,
    }
  },

  async updateProjectDetails(data: {
    projectId: string
    organizationId: string
    /// When provided (even as []), replaces the project's manager set.
    /// When undefined, the existing managers are left untouched.
    projectManagerIds?: string[]
    location?: string
    latitude?: number | null
    longitude?: number | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    let nextPmIds: string[] | undefined
    if (data.projectManagerIds !== undefined) {
      nextPmIds = Array.from(new Set(data.projectManagerIds)).filter(Boolean)
      if (nextPmIds.length > 0) {
        const pms = await prisma.user.findMany({
          where: { id: { in: nextPmIds } },
          select: { id: true, organizationId: true, role: true },
        })
        if (pms.length !== nextPmIds.length) {
          throw new Error("One or more project managers were not found.")
        }
        for (const pm of pms) {
          if (pm.organizationId !== data.organizationId) {
            throw new Error("Project managers must belong to this organization.")
          }
          if (pm.role !== "SUPERVISOR" && pm.role !== "ADMIN") {
            throw new Error("Project managers must be SUPERVISOR or ADMIN.")
          }
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.xeroProject.updateMany({
        where: { id: data.projectId, organizationId: data.organizationId },
        data: {
          // Keep the legacy column in sync with the first picked PM.
          ...(nextPmIds !== undefined
            ? { projectManagerId: nextPmIds[0] ?? null }
            : {}),
          location: data.location || null,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
        },
      })

      if (nextPmIds !== undefined) {
        await tx.projectManager.deleteMany({
          where: { projectId: data.projectId },
        })
        for (const userId of nextPmIds) {
          await tx.projectManager.create({
            data: { projectId: data.projectId, userId },
          })
        }
      }
    })
  },

  async deleteManualProject(data: {
    projectId: string
    organizationId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.xeroProject.deleteMany({
      where: { id: data.projectId, organizationId: data.organizationId, isManual: true },
    })
  },

  async upsertProjectsFromXero(data: {
    xeroConnectionId: string
    organizationId: string
    projects: Array<{
      xeroProjectId: string
      name: string
      status?: string
      contactId?: string
    }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await Promise.all(
      data.projects.map((project) =>
        prisma.xeroProject.upsert({
          where: {
            xeroConnectionId_xeroProjectId: {
              xeroConnectionId: data.xeroConnectionId,
              xeroProjectId: project.xeroProjectId,
            },
          },
          create: {
            organizationId: data.organizationId,
            xeroConnectionId: data.xeroConnectionId,
            xeroProjectId: project.xeroProjectId,
            name: project.name,
            status: project.status,
            contactId: project.contactId,
            isManual: false,
          },
          update: {
            name: project.name,
            status: project.status,
            contactId: project.contactId,
          },
        })
      )
    )
  },

  // ---------------------------------------------------------------------------
  // Tenant management
  // ---------------------------------------------------------------------------

  /**
   * Returns the subset of the given tenantIds that are already connected to a
   * *different* organisation. Used to prevent two orgs sharing the same Xero tenant.
   */
  /// Projects the employee can submit claims for. Unions three sources so
  /// the picker is populated for both new-flow and legacy employees:
  ///   1. EmployeeProjectAssignment rows (canonical for new-flow employees)
  ///   2. Projects the employee has a team membership in (these are the
  ///      ones routing is actually configured for — most important for
  ///      claim submission)
  ///   3. The legacy EmployeeProfile.project string matched by name (for
  ///      employees that pre-date EmployeeProjectAssignment entirely)
  /// Returned sorted by name, deduped by id.
  async getProjectsForEmployee(
    employeeUserId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const profile = await prisma.employeeProfile.findUnique({
      where: { userId: employeeUserId },
      select: {
        id: true,
        project: true,
        user: { select: { organizationId: true } },
        projectAssignments: {
          select: { project: { select: { id: true, name: true } } },
          orderBy: { project: { name: "asc" } },
        },
        teamMemberships: {
          select: { team: { select: { project: { select: { id: true, name: true } } } } },
        },
      },
    })
    if (!profile) return []

    const byId = new Map<string, { id: string; name: string }>()
    for (const a of profile.projectAssignments) {
      byId.set(a.project.id, { id: a.project.id, name: a.project.name })
    }
    for (const t of profile.teamMemberships) {
      byId.set(t.team.project.id, {
        id: t.team.project.id,
        name: t.team.project.name,
      })
    }

    // Legacy free-string project: resolve to a XeroProject by (org, name).
    const legacy = profile.project?.trim()
    if (legacy && profile.user.organizationId) {
      const match = await prisma.xeroProject.findFirst({
        where: { organizationId: profile.user.organizationId, name: legacy },
        select: { id: true, name: true },
      })
      if (match && !byId.has(match.id)) {
        byId.set(match.id, match)
      }
    }

    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  },

  async getInUseTenantIds(
    tenantIds: string[],
    excludeOrganizationId: string
  ): Promise<string[]> {
    const prisma = getPrismaClient()
    if (!prisma || tenantIds.length === 0) return []

    const rows = await prisma.xeroConnection.findMany({
      where: {
        tenantId: { in: tenantIds },
        organizationId: { not: excludeOrganizationId },
      },
      select: { tenantId: true },
    })

    return rows.map((r) => r.tenantId)
  },

  // ---------------------------------------------------------------------------
  // Team-based approval templates
  // ---------------------------------------------------------------------------

  /// List every team across every project owned by `organizationId`,
  /// joined with project name and member count for the Company Structure
  /// admin tab.
  async listTeams(organizationId: string): Promise<TeamSummary[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.team.findMany({
      where: { project: { organizationId } },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: [{ project: { name: "asc" } }, { name: "asc" }],
    })

    return rows.map((row) => mapTeamSummary(row))
  },

  async getTeam(teamId: string, organizationId: string): Promise<TeamDetail | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.team.findFirst({
      where: { id: teamId, project: { organizationId } },
      include: {
        project: { select: { id: true, name: true } },
        memberships: {
          include: {
            employeeProfile: {
              select: {
                id: true,
                userId: true,
                user: { select: { id: true, name: true, role: true } },
              },
            },
          },
          orderBy: [{ layer: "asc" }],
        },
      },
    })

    if (!row) return null

    const summary = mapTeamSummary({
      ...row,
      _count: { memberships: row.memberships.length },
    })
    const members: TeamMembership[] = row.memberships.map((m) => ({
      id: m.id,
      employeeProfileId: m.employeeProfileId,
      userId: m.employeeProfile.userId,
      name: m.employeeProfile.user.name,
      role: m.employeeProfile.user.role === "SUPERVISOR" ? "SUPERVISOR" : "EMPLOYEE",
      layer: m.layer,
      teamId: m.teamId,
    }))

    return { ...summary, members }
  },

  async createTeam(data: {
    organizationId: string
    projectId: string
    name: string
    layerCount: number
    moduleConfig?: TeamModuleConfig
    layerLabels?: string[] | null
  }): Promise<TeamSummary> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    if (data.layerCount < 1 || data.layerCount > 10) {
      throw new Error("Team must have between 1 and 10 layers.")
    }
    const trimmedName = data.name.trim()
    if (!trimmedName) {
      throw new Error("Team name is required.")
    }

    const project = await prisma.xeroProject.findFirst({
      where: { id: data.projectId, organizationId: data.organizationId },
      select: { id: true, name: true },
    })
    if (!project) {
      throw new Error("Project not found in this organization.")
    }

    const cfgInput = data.moduleConfig ?? defaultModuleConfig(data.layerCount)
    const validated = validateModuleConfig(cfgInput, data.layerCount)
    if (!validated.ok) {
      throw new Error(validated.error)
    }

    const labels =
      data.layerLabels && data.layerLabels.length > 0
        ? data.layerLabels.slice(0, data.layerCount)
        : null

    const created = await prisma.team.create({
      data: {
        projectId: project.id,
        name: trimmedName,
        layerCount: data.layerCount,
        layerLabels: labels ?? undefined,
        moduleConfig: validated.value,
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { memberships: true } },
      },
    })
    return mapTeamSummary(created)
  },

  async updateTeam(data: {
    organizationId: string
    teamId: string
    name?: string
    layerCount?: number
    layerLabels?: string[] | null
    moduleConfig?: TeamModuleConfig
  }): Promise<TeamSummary> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const team = await prisma.team.findFirst({
      where: { id: data.teamId, project: { organizationId: data.organizationId } },
      include: {
        memberships: { select: { layer: true } },
      },
    })
    if (!team) throw new Error("Team not found.")

    const nextLayerCount = data.layerCount ?? team.layerCount
    if (nextLayerCount < 1 || nextLayerCount > 10) {
      throw new Error("Team must have between 1 and 10 layers.")
    }
    if (nextLayerCount < team.layerCount) {
      const offending = team.memberships.find((m) => m.layer > nextLayerCount)
      if (offending) {
        throw new Error(
          `Cannot shrink to ${nextLayerCount} layers — at least one member sits at layer ${offending.layer}. Move them first.`,
        )
      }
    }

    let nextModuleCfg: TeamModuleConfig | undefined
    if (data.moduleConfig) {
      const v = validateModuleConfig(data.moduleConfig, nextLayerCount)
      if (!v.ok) throw new Error(v.error)
      nextModuleCfg = v.value
    } else if (data.layerCount !== undefined && data.layerCount < team.layerCount) {
      // Layer count shrunk and no fresh moduleConfig was provided — trim
      // existing one so we don't leave dangling layer numbers.
      const current = parseModuleConfigJson(team.moduleConfig, team.layerCount)
      nextModuleCfg = trimModuleConfig(current, nextLayerCount)
    }

    const trimmedName = data.name?.trim()
    if (data.name !== undefined && !trimmedName) {
      throw new Error("Team name is required.")
    }

    let labelsUpdate: string[] | null | undefined
    if (data.layerLabels !== undefined) {
      labelsUpdate =
        data.layerLabels === null
          ? null
          : data.layerLabels.slice(0, nextLayerCount)
    }

    const updated = await prisma.team.update({
      where: { id: team.id },
      data: {
        ...(trimmedName !== undefined ? { name: trimmedName } : {}),
        ...(data.layerCount !== undefined ? { layerCount: nextLayerCount } : {}),
        ...(labelsUpdate !== undefined
          ? { layerLabels: labelsUpdate ?? undefined }
          : {}),
        ...(nextModuleCfg ? { moduleConfig: nextModuleCfg } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { memberships: true } },
      },
    })
    return mapTeamSummary(updated)
  },

  async deleteTeam(data: {
    organizationId: string
    teamId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const team = await prisma.team.findFirst({
      where: { id: data.teamId, project: { organizationId: data.organizationId } },
      include: { _count: { select: { memberships: true } } },
    })
    if (!team) throw new Error("Team not found.")
    if (team._count.memberships > 0) {
      throw new Error(
        "Remove all members from this team before deleting it.",
      )
    }
    await prisma.team.delete({ where: { id: team.id } })
  },

  async assignTeamMember(data: {
    organizationId: string
    employeeProfileId: string
    teamId: string
    layer: number
  }): Promise<TeamMembership> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const team = await prisma.team.findFirst({
      where: { id: data.teamId, project: { organizationId: data.organizationId } },
      select: { id: true, projectId: true, layerCount: true },
    })
    if (!team) throw new Error("Team not found.")
    if (data.layer < 1 || data.layer > team.layerCount) {
      throw new Error(
        `Layer must be between 1 and ${team.layerCount} for this team.`,
      )
    }

    const profile = await prisma.employeeProfile.findUnique({
      where: { id: data.employeeProfileId },
      include: {
        user: { select: { id: true, name: true, role: true, organizationId: true } },
        projectAssignments: { select: { projectId: true } },
      },
    })
    if (!profile || profile.user.organizationId !== data.organizationId) {
      throw new Error("Employee not found in this organization.")
    }
    const employeeProjectIds = new Set(
      profile.projectAssignments.map((a) => a.projectId),
    )
    if (!employeeProjectIds.has(team.projectId)) {
      throw new Error(
        "Employee is not assigned to the project this team belongs to.",
      )
    }

    const upserted = await prisma.employeeTeamMembership.upsert({
      where: {
        employeeProfileId_teamId: {
          employeeProfileId: profile.id,
          teamId: team.id,
        },
      },
      create: {
        employeeProfileId: profile.id,
        teamId: team.id,
        layer: data.layer,
      },
      update: { layer: data.layer },
    })

    return {
      id: upserted.id,
      employeeProfileId: upserted.employeeProfileId,
      userId: profile.user.id,
      name: profile.user.name,
      role: profile.user.role === "SUPERVISOR" ? "SUPERVISOR" : "EMPLOYEE",
      layer: upserted.layer,
      teamId: upserted.teamId,
    }
  },

  async removeTeamMember(data: {
    organizationId: string
    membershipId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const membership = await prisma.employeeTeamMembership.findUnique({
      where: { id: data.membershipId },
      select: { id: true, team: { select: { project: { select: { organizationId: true } } } } },
    })
    if (
      !membership ||
      membership.team.project.organizationId !== data.organizationId
    ) {
      throw new Error("Membership not found.")
    }
    await prisma.employeeTeamMembership.delete({ where: { id: membership.id } })
  },

  /// Supervisor picker: every SUPERVISOR-role user assigned to `projectId`,
  /// either via EmployeeProjectAssignment or via the legacy `project` string
  /// match. Used by the new employee creation form's "Direct Supervisor"
  /// dropdown — flexible (not strict next-layer-up).
  async listSupervisorsInProject(
    projectId: string,
    organizationId: string,
  ): Promise<Array<{ id: string; name: string; layer?: number; teamId?: string }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const project = await prisma.xeroProject.findFirst({
      where: { id: projectId, organizationId },
      select: { id: true, name: true },
    })
    if (!project) return []

    const supervisors = await prisma.user.findMany({
      where: {
        organizationId,
        role: "SUPERVISOR",
        OR: [
          {
            employeeProfile: {
              projectAssignments: { some: { projectId: project.id } },
            },
          },
          {
            employeeProfile: { project: project.name },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        employeeProfile: {
          select: {
            teamMemberships: {
              where: { team: { projectId: project.id } },
              select: { teamId: true, layer: true },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    })

    return supervisors.map((s) => {
      const membership = s.employeeProfile?.teamMemberships?.[0]
      return {
        id: s.id,
        name: s.name,
        layer: membership?.layer,
        teamId: membership?.teamId,
      }
    })
  },
}

// ---------------------------------------------------------------------------
// Internal helpers (kept inside this file because they only need to know about
// the Prisma row shapes returned above).
// ---------------------------------------------------------------------------

type TeamRow = {
  id: string
  projectId: string
  name: string
  layerCount: number
  layerLabels: unknown
  moduleConfig: unknown
  project: { id: string; name: string }
  _count: { memberships: number }
}

function mapTeamSummary(row: TeamRow): TeamSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.project.name,
    name: row.name,
    layerCount: row.layerCount,
    layerLabels: parseLayerLabels(row.layerLabels),
    moduleConfig: parseModuleConfigJson(row.moduleConfig, row.layerCount),
    memberCount: row._count.memberships,
  }
}

function parseLayerLabels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const labels: string[] = []
  for (const item of raw) {
    if (typeof item === "string") labels.push(item)
  }
  return labels.length > 0 ? labels : undefined
}

function parseModuleConfigJson(raw: unknown, layerCount: number): TeamModuleConfig {
  const validated = validateModuleConfig(raw, layerCount)
  if (validated.ok) return validated.value
  // If the persisted JSON is invalid (legacy / corrupted), fall back to the
  // safe default so the UI still works.
  return defaultModuleConfig(layerCount)
}
