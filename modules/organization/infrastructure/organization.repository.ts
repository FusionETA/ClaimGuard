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
  XeroConnectionInfo,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"
import {
  resolveAssignedProjects,
  resolveEmployeePayoutMethod,
  resolvePrimaryProjectName,
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
        defaultMileageRate?: unknown
        mileageUnit?: string | null
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
    defaultMileageRate,
    mileageUnit: (org.mileageUnit as MileageUnit | null | undefined) === "MILE" ? "MILE" : "KM",
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
          },
        },
        approvalChainSteps: {
          include: { approver: { select: { id: true, name: true } } },
          orderBy: { step: "asc" },
        },
      },
      orderBy: { name: "asc" },
    })

    return rows.map((user) => {
      // If there's no chain row yet but a legacy supervisorId is set, surface
      // it as a synthetic 1-step chain so the UI can treat supervisor and the
      // chain as the same thing. Saving the chain will persist it to the DB.
      const persistedChain = user.approvalChainSteps.map((s) => ({
        step: s.step,
        approverId: s.approverId,
        approverName: s.approver.name,
      }))
      const supervisorId = user.employeeProfile?.supervisorId ?? undefined
      const supervisorName = user.employeeProfile?.supervisor?.name ?? undefined
      const approvalChain =
        persistedChain.length === 0 && supervisorId && supervisorName
          ? [{ step: 1, approverId: supervisorId, approverName: supervisorName }]
          : persistedChain
      const assignedProjects = mapAssignedProjects(
        user.employeeProfile?.project,
        user.employeeProfile?.projectAssignments ?? [],
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
        supervisorId,
        supervisorName,
        xeroConnectionId: user.employeeProfile?.xeroConnectionId ?? undefined,
        xeroConnectionName: user.employeeProfile?.xeroConnection?.tenantName ?? undefined,
        approvalChain,
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
    xeroConnectionId?: string
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

    await prisma.$transaction([
      prisma.user.update({
        where: { id: data.userId },
        data: {
          role: data.role,
          organizationId: data.organizationId,
        },
      }),
      prisma.employeeProfile.update({
        where: { userId: data.userId },
        data: {
          project: primaryProjectName,
          jobTitle: data.jobTitle,
          payoutMethod: resolveEmployeePayoutMethod(data.role, data.payoutMethod),
          xeroConnectionId: data.xeroConnectionId || null,
        },
      }),
      prisma.employeeProjectAssignment.deleteMany({
        where: {
          employeeProfile: {
            userId: data.userId,
          },
        },
      }),
      ...data.projectIds.map((projectId) =>
        prisma.employeeProjectAssignment.create({
          data: {
            employeeProfile: { connect: { userId: data.userId } },
            project: { connect: { id: projectId } },
          },
        })
      ),
    ])

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
    supervisorId?: string
    xeroConnectionId?: string
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

    if (data.supervisorId) {
      const supervisor = await prisma.user.findUnique({
        where: { id: data.supervisorId },
        select: { organizationId: true, role: true },
      })

      if (
        !supervisor ||
        supervisor.organizationId !== data.organizationId ||
        supervisor.role !== "SUPERVISOR"
      ) {
        throw new Error("Supervisor must belong to your organization.")
      }
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
            supervisorId: data.supervisorId || null,
            payoutMethod: resolveEmployeePayoutMethod(data.role, data.payoutMethod),
            preferredCurrency: "USD",
            xeroConnectionId: data.xeroConnectionId || null,
            projectAssignments: {
              create: data.projectIds.map((projectId) => ({
                project: { connect: { id: projectId } },
              })),
            },
          },
        },
      },
      select: { id: true },
    })

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
      include: { projectManager: { select: { id: true, name: true } } },
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
      include: { projectManager: { select: { id: true, name: true } } },
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
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      isManual: row.isManual,
    }))
  },

  async createManualProject(data: {
    organizationId: string
    name: string
    projectManagerId?: string
    location?: string
    latitude?: number
    longitude?: number
  }): Promise<OrganizationProjectOption> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    if (data.projectManagerId) {
      const pm = await prisma.user.findUnique({
        where: { id: data.projectManagerId },
        select: { organizationId: true, role: true },
      })

      if (
        !pm ||
        pm.organizationId !== data.organizationId ||
        pm.role !== "SUPERVISOR"
      ) {
        throw new Error("Project manager must be a supervisor in this organization.")
      }
    }

    const row = await prisma.xeroProject.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        projectManagerId: data.projectManagerId || null,
        location: data.location || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        isManual: true,
      },
      include: { projectManager: { select: { id: true, name: true } } },
    })

    return {
      id: row.id,
      name: row.name,
      projectManagerId: row.projectManagerId ?? undefined,
      projectManagerName: row.projectManager?.name ?? undefined,
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      isManual: true,
    }
  },

  async updateProjectDetails(data: {
    projectId: string
    organizationId: string
    projectManagerId?: string
    location?: string
    latitude?: number | null
    longitude?: number | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    if (data.projectManagerId) {
      const pm = await prisma.user.findUnique({
        where: { id: data.projectManagerId },
        select: { organizationId: true, role: true },
      })

      if (
        !pm ||
        pm.organizationId !== data.organizationId ||
        pm.role !== "SUPERVISOR"
      ) {
        throw new Error("Project manager must be a supervisor in this organization.")
      }
    }

    await prisma.xeroProject.updateMany({
      where: { id: data.projectId, organizationId: data.organizationId },
      data: {
        projectManagerId: data.projectManagerId || null,
        location: data.location || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
      },
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
}
