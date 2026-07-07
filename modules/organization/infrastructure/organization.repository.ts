import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { randomBytes } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
import { hashPassword } from "@/lib/auth/password"
import { assertEmailAvailableForNewUser } from "@/lib/auth/email-uniqueness"
import { parseAllowedCurrencies } from "@/lib/currencies"
import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { getXeroReauthVersion } from "@/lib/xero"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import {
  type LeaveSeedInput,
  seedEmployeeLeaveEntitlements,
} from "@/modules/leave/application/services/leave-entitlements.service"
import { mapChartAccount } from "@/modules/organization/infrastructure/chart-account.mapper"
import type {
  AdminOrganizationOption,
  AssignedProject,
  ChartOfAccountOption,
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
  dailyThresholdMinutes: 480,
}

export type XeroConnectionRecord = {
  id: string
  organizationId: string
  tenantId: string
  /// Xero's own connection ID (see schema comment on `XeroConnection.xeroConnectionId`).
  /// Nullable for rows created before the column was added.
  xeroConnectionId: string | null
  tenantName: string
  tenantType: string | null
  accessToken: string
  refreshToken: string
  scope: string
  tokenType: string
  accessTokenExpiresAt: Date
  createdAt: Date
  updatedAt: Date
  /// Xero Tracking Category the admin picked to drive the projects
  /// list. Null until the admin chooses one in settings — sync is a
  /// no-op while null. Name is cached so the settings UI doesn't
  /// have to round-trip Xero on every page load.
  xeroTrackingCategoryId: string | null
  xeroTrackingCategoryName: string | null
}

// `toNumber` lives in `lib/decimal.ts` — re-aliased locally for the older
// callers below that pass a fallback positionally.
const toNumberOr = (value: unknown, fallback: number) => toNumber(value, fallback)

/**
 * Coerce a Prisma `Json?` column value into a `string[]` (or `null` when
 * the column was null). Used for the access-scope columns on
 * AdminOrganization (`modules`, `policyIds`) which we want as plain
 * string arrays in TypeScript but live as JSON in MariaDB.
 *
 * Returns `null` for null / undefined / non-array values so the caller
 * can fall back to "full access" semantics cleanly. Non-string entries
 * inside the array are skipped (defensive — we never write them, but a
 * hand-edit could).
 */
function jsonToStringArray(value: unknown): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) return null
  return value.filter((v): v is string => typeof v === "string")
}

function mapOrganizationSummary(
  org?:
    | {
        id: string
        name: string
        claimCutoffDay: number
        otRateNormalDay?: unknown
        otRateRestDay?: unknown
        otRatePublicHoliday?: unknown
        restDayInShiftRate?: unknown
        publicHolidayInShiftRate?: unknown
        otSalaryThreshold?: unknown
        otDailyThresholdMinutes?: number | null
        otEnabled?: boolean | null
        defaultMileageRate?: unknown
        mileageUnit?: string | null
        geofenceRadiusMeters?: number | null
        allowedCurrencies?: unknown
        defaultCurrency?: string | null
        supervisorReportEnabled?: boolean | null
        supervisorSlaMinutes?: number | null
        allowForecastedLeaveApply?: boolean | null
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
    otRates: {
      normalDay: toNumberOr(org.otRateNormalDay, DEFAULT_OT_RATES.normalDay),
      restDay: toNumberOr(org.otRateRestDay, DEFAULT_OT_RATES.restDay),
      publicHoliday: toNumberOr(org.otRatePublicHoliday, DEFAULT_OT_RATES.publicHoliday),
      restDayInShift: toNumberOr(org.restDayInShiftRate, DEFAULT_OT_RATES.restDayInShift),
      publicHolidayInShift: toNumberOr(
        org.publicHolidayInShiftRate,
        DEFAULT_OT_RATES.publicHolidayInShift
      ),
      salaryThreshold:
        org.otSalaryThreshold == null
          ? DEFAULT_OT_RATES.salaryThreshold
          : toNumberOr(
              org.otSalaryThreshold,
              DEFAULT_OT_RATES.salaryThreshold ?? 4000,
            ),
      dailyThresholdMinutes:
        org.otDailyThresholdMinutes ?? DEFAULT_OT_RATES.dailyThresholdMinutes,
    },
    otEnabled: org.otEnabled ?? true,
    defaultMileageRate,
    mileageUnit: (org.mileageUnit as MileageUnit | null | undefined) === "MILE" ? "MILE" : "KM",
    geofenceRadiusMeters: org.geofenceRadiusMeters ?? 200,
    allowedCurrencies: parseAllowedCurrencies(org.allowedCurrencies),
    defaultCurrency:
      typeof org.defaultCurrency === "string" && org.defaultCurrency.trim().length > 0
        ? org.defaultCurrency.trim().toUpperCase()
        : undefined,
    supervisorReportEnabled: org.supervisorReportEnabled ?? true,
    supervisorSlaMinutes: org.supervisorSlaMinutes ?? 60,
    allowForecastedLeaveApply: org.allowForecastedLeaveApply ?? false,
  }
}

function mapAssignedProjects(
  assignments: Array<{ project: { id: string; name: string } }> = [],
): AssignedProject[] {
  return resolveAssignedProjects(
    assignments.map((assignment) => assignment.project),
  )
}

/**
 * Module-scoped Prisma accessor for the organization module. Services
 * call this instead of `getPrismaClient()` from `@/lib/prisma` so all
 * organization-related DB access flows through the infrastructure layer.
 */
export function getOrganizationPrismaClient() {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured")
  return prisma
}

export function getOrganizationPrismaClientSafe() {
  return getPrismaClient()
}

/**
 * Multi-org linking probe used by `createOrganizationMember`.
 *
 * Returns the existing `User` id when the incoming email belongs to an
 * ACTIVE portal user (EMPLOYEE / SUPERVISOR) who does NOT already have
 * an `EmployeeProfile` at `organizationId` — i.e. the "same person, new
 * company" case. Returns `null` otherwise:
 *   - No user has this email → NEW-user path (create fresh).
 *   - User exists but is an admin/owner → NEW-user path (they use SSO
 *     auth; portal linking here would confuse things).
 *   - User exists AND already has a profile at this org → NEW-user
 *     path so `assertEmailAvailableForNewUser` throws the normal
 *     "email in use" error the admin expects.
 *
 * The active/archived rule here matches `lib/auth/email-uniqueness.ts`:
 * a user is active when they have no PayrollProfile, or when their
 * PayrollProfile.isArchived is false.
 */
async function findLinkableExistingUserForOrgInternal(input: {
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>
  email: string
  organizationId: string
}): Promise<{ id: string; name: string; role: string } | null> {
  const { prisma, email, organizationId } = input
  const normalised = email.trim().toLowerCase()
  const candidates = await prisma.user.findMany({
    where: { email: normalised },
    take: 5,
    select: {
      id: true,
      name: true,
      role: true,
      employeeProfiles: {
        select: {
          organizationId: true,
          payrollProfile: { select: { isArchived: true } },
        },
      },
    },
  })
  for (const c of candidates) {
    // Only link portal users. Admins/owners have their own onboarding
    // path (createAdminForOrganization / createOwnerForOrganization).
    if (c.role !== "EMPLOYEE" && c.role !== "SUPERVISOR") continue

    // Skip if any of this user's existing profiles at ANY org is
    // archived — matches the "IN_USE_ACTIVE" definition. An archived
    // user isn't a link candidate; they should be Restored on the
    // original org, not re-linked here.
    const anyArchived = c.employeeProfiles.some(
      (p) => p.payrollProfile?.isArchived === true,
    )
    if (anyArchived) continue

    // Already a member of this org → NOT linkable; let the normal
    // duplicate-email guard fire.
    const alreadyAtOrg = c.employeeProfiles.some(
      (p) => p.organizationId === organizationId,
    )
    if (alreadyAtOrg) continue

    return { id: c.id, name: c.name, role: c.role }
  }
  return null
}

export const organizationRepository = {
  /**
   * Public wrapper around `findLinkableExistingUserForOrgInternal` so
   * the payroll XLSX importer + any other create-employee entry point
   * can share the same "should we link an existing user" classifier as
   * `createOrganizationMember`. Returns `null` when the row should
   * follow the fresh-create path (no user, admin/owner, or already at
   * this org). Returns `{ id, name, role }` when the row should link.
   */
  async findLinkableExistingUserForOrg(input: {
    email: string
    organizationId: string
  }): Promise<{ id: string; name: string; role: string } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    return findLinkableExistingUserForOrgInternal({
      prisma,
      email: input.email,
      organizationId: input.organizationId,
    })
  },

  async getOrganizationById(organizationId: string): Promise<OrganizationSummary | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.organization.findUnique({
      where: { id: organizationId },
    })

    return mapOrganizationSummary(row) ?? null
  },

  /**
   * Lightweight projection of an org's subscription plan + addons,
   * used by the admin / employee layout shells to gate navigation
   * by what the org actually pays for. Cheap — three columns, no
   * relations. Returns `null` for legacy orgs that have no plan
   * recorded yet (caller treats null as "full access" to preserve
   * existing tenants' nav).
   */
  async getOrgPlanModules(organizationId: string): Promise<{
    plan: string
    tier: string | null
    addons: unknown
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { plan: true, tier: true, addons: true },
    })
    if (!row) return null
    return { plan: row.plan, tier: row.tier, addons: row.addons }
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

  /**
   * Seed the per-org defaults a brand-new tenant needs to be usable
   * without the admin having to click through every Settings tab:
   *
   *   - Two `EmployeePolicy` rows ("Monthly Workers", "Hourly Workers").
   *     The first one created (Monthly) becomes the org default via
   *     `policyRepository.create`'s auto-default rule.
   *   - One `XeroProject` named "<Org> Project (default)".
   *   - One `Team` under that project, single-layer, named
   *     "<Org> Team (default)".
   *
   * Idempotent on every aggregate: each block checks count first so
   * re-runs (or calling from `upsertAdminOrganization` on update) are
   * no-ops. Wrapped in try/catch so a partial seed never blocks org
   * creation — the admin can still fix things from Settings.
   */
  async seedDefaultsForNewOrganization(
    organizationId: string,
    organizationName: string,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    const trimmedName = organizationName.trim() || "Organization"

    try {
      const policyCount = await prisma.employeePolicy.count({
        where: { organizationId },
      })
      if (policyCount === 0) {
        const otRates = {
          otRateNormalDay: 1.5,
          otRateRestDay: 2.0,
          otRatePublicHoliday: 3.0,
          otRateRestDayInShift: 1.0,
          otRatePublicHolidayInShift: 2.0,
          otSalaryThreshold: null as number | null,
          otDailyThresholdMinutes: 480,
        }
        const flags = {
          canAccessAttendance: true,
          canAccessClaims: true,
          canAccessLeave: true,
          otEnabled: true,
          otMethod: "CASH" as const,
          requireGeofence: true,
          requireSelfie: false,
          temporary: false,
        }
        // Create Monthly first so it becomes the auto-default policy.
        await policyRepository.create({
          organizationId,
          name: "Monthly Workers",
          salaryType: "MONTHLY_BASED",
          ...flags,
          ...otRates,
        })
        await policyRepository.create({
          organizationId,
          name: "Hourly Workers",
          salaryType: "HOURLY",
          ...flags,
          ...otRates,
        })
      }

      let projectId: string | null = null
      const projectCount = await prisma.xeroProject.count({
        where: { organizationId },
      })
      if (projectCount === 0) {
        const project = await this.createManualProject({
          organizationId,
          name: `${trimmedName} Project (default)`,
        })
        projectId = project.id
      } else {
        const first = await prisma.xeroProject.findFirst({
          where: { organizationId },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
        projectId = first?.id ?? null
      }

      if (projectId) {
        const teamCount = await prisma.team.count({
          where: { project: { organizationId } },
        })
        if (teamCount === 0) {
          await this.createTeam({
            organizationId,
            projectId,
            name: `${trimmedName} Team (default)`,
            layerCount: 1,
          })
        }
      }
    } catch (err) {
      // Never block org creation on seeding — the admin can still fix
      // any missing default from Settings.
      console.warn("[seedDefaultsForNewOrganization] partial seed:", err)
    }
  },

  /**
   * Resolve the org's seeded "default" Policy / Project / Team IDs so
   * the bulk-import preview can pre-select them on rows where the
   * XLSX cell is blank. Returns nulls for any default that doesn't
   * exist (legacy orgs created before `seedDefaultsForNewOrganization`
   * shipped — callers tolerate null and fall back to the existing
   * blank-picker behaviour).
   *
   * Lookup rule:
   *   - Policy: prefer "Monthly Workers" (Hourly returned as well so
   *     the wizard could surface both, but the preview only uses
   *     monthly today).
   *   - Project / Team: match by suffix " Project (default)" /
   *     " Team (default)" rather than the full org-prefixed name, so
   *     an org rename after seeding doesn't break the lookup. Falls
   *     back to the oldest project / team for the org if no
   *     suffix-marked row exists (legacy orgs).
   */
  async getOrgImportDefaults(organizationId: string): Promise<{
    monthlyPolicyId: string | null
    hourlyPolicyId: string | null
    projectId: string | null
    teamId: string | null
    teamLayer: number
  }> {
    const prisma = getPrismaClient()
    if (!prisma) {
      return {
        monthlyPolicyId: null,
        hourlyPolicyId: null,
        projectId: null,
        teamId: null,
        teamLayer: 1,
      }
    }
    // Look up by salaryType + isDefault, falling back to any
    // non-archived policy of that type. This is more robust than a
    // hard-coded "Monthly Workers" name lookup — admins may have
    // renamed / deleted the seeded policy, and we still want a
    // sensible default policy of the right pay type.
    const [
      monthlyDefault,
      monthlyAny,
      hourlyDefault,
      hourlyAny,
      projectSeeded,
      teamSeeded,
    ] = await Promise.all([
      prisma.employeePolicy.findFirst({
        where: {
          organizationId,
          salaryType: "MONTHLY_BASED",
          isDefault: true,
          archivedAt: null,
        },
        select: { id: true },
      }),
      prisma.employeePolicy.findFirst({
        where: {
          organizationId,
          salaryType: "MONTHLY_BASED",
          archivedAt: null,
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.employeePolicy.findFirst({
        where: {
          organizationId,
          salaryType: "HOURLY",
          isDefault: true,
          archivedAt: null,
        },
        select: { id: true },
      }),
      prisma.employeePolicy.findFirst({
        where: {
          organizationId,
          salaryType: "HOURLY",
          archivedAt: null,
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.xeroProject.findFirst({
        where: {
          organizationId,
          name: { endsWith: " Project (default)" },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.team.findFirst({
        where: {
          project: { organizationId },
          name: { endsWith: " Team (default)" },
        },
        select: { id: true, layerCount: true },
        orderBy: { createdAt: "asc" },
      }),
    ])
    // Legacy-org fallback: if the seeded "(default)"-suffixed rows
    // don't exist, pick the oldest project / team so the preview
    // still has something sensible to pre-select.
    const project =
      projectSeeded ??
      (await prisma.xeroProject.findFirst({
        where: { organizationId },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }))
    const team =
      teamSeeded ??
      (project
        ? await prisma.team.findFirst({
            where: { projectId: project.id },
            select: { id: true, layerCount: true },
            orderBy: { createdAt: "asc" },
          })
        : null)
    return {
      monthlyPolicyId: monthlyDefault?.id ?? monthlyAny?.id ?? null,
      hourlyPolicyId: hourlyDefault?.id ?? hourlyAny?.id ?? null,
      projectId: project?.id ?? null,
      teamId: team?.id ?? null,
      teamLayer: 1,
    }
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

    if (!admin || !isAdminRole(admin.role)) {
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

    await this.seedDefaultsForNewOrganization(org.id, org.name)

    return { id: org.id, name: org.name }
  },

  /**
   * Add an admin to an org. Optional `access` lets the owner restrict
   * modules / policies at invite time; omit it (or pass null) for full
   * access (legacy behaviour). On an existing link, the access is
   * REPLACED — owners can use this method to revoke previously-granted
   * scope by re-linking with a narrower scope.
   */
  async linkAdminToOrganization(
    adminId: string,
    organizationId: string,
    access?: {
      modules?: string[] | null
      policyIds?: string[] | null
    },
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const modules = access?.modules ?? null
    const policyIds = access?.policyIds ?? null

    await prisma.adminOrganization.upsert({
      where: { adminId_organizationId: { adminId, organizationId } },
      create: {
        adminId,
        organizationId,
        modules: modules ?? Prisma.JsonNull,
        policyIds: policyIds ?? Prisma.JsonNull,
      },
      update: {
        modules: modules ?? Prisma.JsonNull,
        policyIds: policyIds ?? Prisma.JsonNull,
      },
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

    if (admin != null && isAdminRole(admin.role) && admin.organizationId === organizationId) {
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

    if (!admin || !isAdminRole(admin.role)) {
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

    await this.seedDefaultsForNewOrganization(organization.id, organization.name)

    return mapOrganizationSummary(organization)!
  },

  /**
   * List every admin tied to an organization. Two paths union'd:
   *   - User.organizationId === orgId (admins whose home org is this one).
   *   - Anyone joined via AdminOrganization (multi-org admins).
   * De-duplicated by user id, ordered by createdAt ascending so the
   * earliest admin appears first.
   */
  async listAdminsForOrganization(organizationId: string): Promise<
    Array<{
      id: string
      email: string
      name: string
      role: "ADMIN" | "OWNER"
      createdAt: string
      /// Module + policy access scope for this admin in this org. `null`
      /// on either field means "full access" (legacy behaviour for
      /// rows written before the access columns shipped). Always `null`
      /// for OWNER rows — owners always have full access by definition.
      access: {
        modules: string[] | null
        policyIds: string[] | null
      }
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.user.findMany({
      where: {
        // OWNER is an admin superset — show owners in the admins list too
        // (badged + non-removable in the UI).
        role: { in: ["ADMIN", "OWNER"] },
        OR: [
          { organizationId },
          { adminOrganizations: { some: { organizationId } } },
        ],
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        // Pull the matching AdminOrganization row to read access scope.
        // Only the row for THIS org matters — multi-org admins have
        // independent scope per org.
        adminOrganizations: {
          where: { organizationId },
          select: { modules: true, policyIds: true },
          take: 1,
        },
      },
      orderBy: { createdAt: "asc" },
    })

    return rows.map((u) => {
      const adminOrg = u.adminOrganizations[0]
      // Owners get full access regardless of what's stored.
      const isOwner = u.role === "OWNER"
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role as "ADMIN" | "OWNER",
        createdAt: u.createdAt.toISOString(),
        access: {
          modules: isOwner
            ? null
            : (jsonToStringArray(adminOrg?.modules) ?? null),
          policyIds: isOwner
            ? null
            : (jsonToStringArray(adminOrg?.policyIds) ?? null),
        },
      }
    })
  },

  /**
   * Resolve the module-access scope for the signed-in admin in ONE org —
   * used by the admin shell to filter sidebar nav. Returns:
   *   • `null` → full access (Owner role, or the legacy default when
   *     the `modules` column hasn't been written yet).
   *   • `string[]` → restricted to these module keys.
   *
   * Caller passes `userRole` so we can early-return for OWNERs without
   * touching the AdminOrganization row. Returns `null` when there's no
   * AdminOrganization row at all (legacy/primary admins whose link
   * lives only via `User.organizationId`) — they keep the existing
   * equal-tier behaviour until the owner edits their scope.
   */
  async getAdminModulesForOrg(input: {
    adminId: string
    organizationId: string
    userRole: "ADMIN" | "OWNER" | "EMPLOYEE" | "SUPERVISOR"
  }): Promise<string[] | null> {
    if (input.userRole === "OWNER") return null
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.adminOrganization.findUnique({
      where: {
        adminId_organizationId: {
          adminId: input.adminId,
          organizationId: input.organizationId,
        },
      },
      select: { modules: true },
    })
    if (!row) return null
    return jsonToStringArray(row.modules)
  },

  /**
   * Twin to `getAdminModulesForOrg` — reads the policy-id scope used by
   * row-level filters on every list query (claims, leave, attendance,
   * employees). Owner returns null; legacy admin (no row) returns null;
   * restricted admin returns their picked ids. Empty array means "scope
   * is empty — show no rows" (rare but legitimate).
   */
  async getAdminPolicyIdsForOrg(input: {
    adminId: string
    organizationId: string
    userRole: "ADMIN" | "OWNER" | "EMPLOYEE" | "SUPERVISOR"
  }): Promise<string[] | null> {
    if (input.userRole === "OWNER") return null
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.adminOrganization.findUnique({
      where: {
        adminId_organizationId: {
          adminId: input.adminId,
          organizationId: input.organizationId,
        },
      },
      select: { policyIds: true },
    })
    if (!row) return null
    return jsonToStringArray(row.policyIds)
  },

  /**
   * Replace an admin's module + policy access scope for ONE org.
   * Caller passes `null` for either field to mean "full access" (clears
   * the column to NULL). Passes an empty array for "no access".
   *
   * Owner-only at the action layer — this repo method just persists.
   * Idempotent: re-saving the same values is a harmless write.
   */
  async updateAdminAccess(input: {
    adminId: string
    organizationId: string
    modules: string[] | null
    policyIds: string[] | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    await prisma.adminOrganization.upsert({
      where: {
        adminId_organizationId: {
          adminId: input.adminId,
          organizationId: input.organizationId,
        },
      },
      create: {
        adminId: input.adminId,
        organizationId: input.organizationId,
        modules: input.modules ?? Prisma.JsonNull,
        policyIds: input.policyIds ?? Prisma.JsonNull,
      },
      update: {
        modules: input.modules ?? Prisma.JsonNull,
        policyIds: input.policyIds ?? Prisma.JsonNull,
      },
    })
  },

  /**
   * Look up a user by email (case-insensitive). Used by the owner's
   * "invite admin" flow to detect when the typed email already belongs
   * to someone — so an existing admin can be linked to another org
   * instead of erroring on the unique-email constraint.
   */
  async findUserByEmail(email: string): Promise<{
    id: string
    name: string
    email: string
    role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER"
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    // Email is no longer DB-unique — return the active row only so a
    // stale archived account doesn't shadow a fresh one with the same
    // address. Active = no PayrollProfile OR PayrollProfile.isArchived
    // is false.
    const user = await prisma.user.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        OR: [
          { employeeProfiles: { none: {} } },
          {
            employeeProfiles: {
              some: {
                OR: [
                  { payrollProfile: null },
                  { payrollProfile: { isArchived: false } },
                ],
              },
            },
          },
        ],
      },
      select: { id: true, name: true, email: true, role: true },
    })
    return user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER",
        }
      : null
  },

  /**
   * Find a user by email PLUS their EmployeeProfile.phone — used by
   * the WhatsApp-based password-reset flow to look up where to
   * deliver the 6-digit code. `phone` is null when the user has no
   * EmployeeProfile (admins / owners without one) or when the field
   * is blank, so the caller can decide to skip / fall back.
   */
  async findUserWithPhoneByEmail(email: string): Promise<{
    id: string
    name: string
    email: string
    role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER"
    phone: string | null
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    // Active row only — see the sibling lookup above for rationale.
    // Returning the archived user here would let the password-reset
    // flow deliver a code to an off-boarded employee's WhatsApp.
    const user = await prisma.user.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        OR: [
          { employeeProfiles: { none: {} } },
          {
            employeeProfiles: {
              some: {
                OR: [
                  { payrollProfile: null },
                  { payrollProfile: { isArchived: false } },
                ],
              },
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        // Phone lives on PayrollProfile, NOT EmployeeProfile — chain
        // through both relations. Returns null when the employee
        // isn't enrolled in payroll yet. Multi-org: pick the first
        // profile's phone; a follow-up rollout will route this by
        // active org.
        employeeProfiles: {
          select: { payrollProfile: { select: { phone: true } } },
          take: 1,
        },
      },
    })
    if (!user) return null
    const rawPhone =
      user.employeeProfiles?.[0]?.payrollProfile?.phone?.trim() ?? ""
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER",
      phone: rawPhone.length > 0 ? rawPhone : null,
    }
  },

  /**
   * Find a user by id. Same shape as `findUserByEmail` PLUS the
   * scrypt password hash for callers that need to verify or update
   * the user's password (currently the change-password and password-
   * reset flows). Trusted callers only — never expose `passwordHash`
   * back to the client.
   */
  async findUserByIdWithHash(id: string): Promise<{
    id: string
    name: string
    email: string
    role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER"
    passwordHash: string
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        passwordHash: true,
      },
    })
    return user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER",
          passwordHash: user.passwordHash,
        }
      : null
  },

  /**
   * Overwrite the scrypt password hash for a user. The caller must
   * have already verified authorisation to do this (current-password
   * check for change-password; valid reset code for forgot-password).
   */
  async updateUserPasswordHash(id: string, passwordHash: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    })
  },

  /**
   * Remove an admin's access to ONE organization. Deletes the
   * `AdminOrganization` join row. If this org happened to be the admin's
   * "home" org (`User.organizationId`), we re-point that to another org
   * they still administer (or null) so `listAdminsForOrganization`
   * stops returning them for this org. Owner-gated at the caller.
   */
  async unlinkAdminFromOrganization(
    adminId: string,
    organizationId: string,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.adminOrganization.deleteMany({
      where: { adminId, organizationId },
    })

    const user = await prisma.user.findUnique({
      where: { id: adminId },
      select: { organizationId: true },
    })
    if (user?.organizationId === organizationId) {
      const remaining = await prisma.adminOrganization.findFirst({
        where: { adminId },
        select: { organizationId: true },
        orderBy: { createdAt: "asc" },
      })
      await prisma.user.update({
        where: { id: adminId },
        data: { organizationId: remaining?.organizationId ?? null },
      })
    }
  },

  /**
   * Create a new admin user tied to the given organization. The caller
   * (a server action) must have already verified the requesting user is
   * an admin in this org.
   *
   * `password` is the temporary password the inviting admin types on the
   * form — the new admin should change it on first login. We hash it
   * before persisting (lib/auth/password's hashPassword is the same
   * helper used by the original admin signup flow).
   *
   * Throws on email collision (Prisma unique constraint surfaces as a
   * code "P2002" — caller maps that to a friendly message).
   */
  async createAdminForOrganization(input: {
    organizationId: string
    email: string
    name: string
    password: string
    /// Optional initial access scope picked on the invite form. Omit
    /// or pass null for full access (legacy behaviour). The owner can
    /// edit scope from the admin row's "Manage access" dialog later.
    access?: {
      modules?: string[] | null
      policyIds?: string[] | null
    }
  }): Promise<{ id: string; email: string; name: string }> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    const email = input.email.trim().toLowerCase()
    const name = input.name.trim()

    // New "at most one active user per email globally" rule replaces
    // the old DB-level @unique that used to guard this create. Throws
    // EmailNotAvailableError; callers should surface the message.
    await assertEmailAvailableForNewUser({
      email,
      orgId: input.organizationId,
    })

    const modules = input.access?.modules ?? null
    const policyIds = input.access?.policyIds ?? null

    const created = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash: hashPassword(input.password),
        role: "ADMIN",
        // Tying the new admin to the same org via both columns matches
        // how the primary admin is represented (organizationId set) AND
        // adds the AdminOrganization join row that drives multi-org
        // admins. The "primary admin" of the org is whoever has
        // organizationId set; everyone else is a join-row only.
        organizationId: input.organizationId,
        adminOrganizations: {
          create: {
            organizationId: input.organizationId,
            modules: modules ?? Prisma.JsonNull,
            policyIds: policyIds ?? Prisma.JsonNull,
          },
        },
      },
      select: { id: true, email: true, name: true },
    })

    return created
  },

  /**
   * Create (or link) the OWNER for an organization — used by the master
   * API when Altomate Accounting provisions a paid HR tenant. The owner
   * authenticates via the SSO hand-off, never with a password here, so we
   * store a random unusable hash. Idempotent: if the email already exists
   * we just ensure the AdminOrganization link (so re-provisioning the same
   * customer is safe) without touching their existing role.
   */
  async createOwnerForOrganization(input: {
    organizationId: string
    email: string
    name: string
    /// When the caller knows which admin modules the org's plan grants
    /// (partner API → derived from plan/tier/addons), pass them here
    /// so the new AdminOrganization row is seeded with the right
    /// scope. The owner's dashboard nav then reflects what they're
    /// paying for from day one. Omit (or pass null) to mean "full
    /// access" — the legacy behaviour kept for non-API call sites.
    modules?: readonly string[] | null
  }): Promise<{ id: string; email: string; name: string; created: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const email = input.email.trim().toLowerCase()
    const name = input.name.trim()
    const modulesJson =
      input.modules == null
        ? Prisma.JsonNull
        : [...input.modules]

    // Owner provisioning is idempotent — if a user with this email
    // already exists (active OR archived in any org), link them as
    // owner of the new org rather than creating a parallel record.
    // findFirst because email is no longer DB-unique.
    const existing = await prisma.user.findFirst({
      where: { email },
      select: { id: true, name: true },
    })
    if (existing) {
      await prisma.adminOrganization.upsert({
        where: {
          adminId_organizationId: {
            adminId: existing.id,
            organizationId: input.organizationId,
          },
        },
        create: {
          adminId: existing.id,
          organizationId: input.organizationId,
          modules: modulesJson,
        },
        // Don't overwrite an existing modules grant on re-provisioning;
        // the owner may have customised it via the admin UI since the
        // initial create.
        update: {},
      })
      return { id: existing.id, email, name: existing.name, created: false }
    }

    // No usable password — the owner only ever enters via the signed SSO
    // hand-off from Altomate Accounting.
    const randomPassword = randomBytes(24).toString("base64url")
    const created = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash: hashPassword(randomPassword),
        role: "OWNER",
        organizationId: input.organizationId,
        adminOrganizations: {
          create: {
            organizationId: input.organizationId,
            modules: modulesJson,
          },
        },
      },
      select: { id: true, email: true, name: true },
    })
    return { ...created, created: true }
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
        otDailyThresholdMinutes: data.rates.dailyThresholdMinutes,
      },
    })
  },

  /**
   * Pre-check the unique `Organization.name` so callers can return a
   * tailored 409 instead of a generic 500 from the unique-violation
   * during create. Race-safe enough for our purposes — the create()
   * remains the source of truth.
   */
  async findOrganizationByName(
    name: string,
  ): Promise<{ id: string } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.organization.findUnique({
      where: { name },
      select: { id: true },
    })
    return row ?? null
  },

  /**
   * Atomically provision a new tenant: create the Organization and an
   * `ApiIntegration` token tied to the issuing master key. Either both
   * rows commit or neither does — keeps the partner integration from
   * landing in a state where an org exists without a way to call its
   * APIs.
   */
  async createOrganizationWithApiIntegration(input: {
    organizationName: string
    integration: {
      name: string
      tokenHash: string
      tokenPrefix: string
      scopes: readonly string[]
      issuedByMasterKeyId: string
    }
    /// Subscription plan recorded on the new org. Drives navigation
    /// gating in admin + employee shells. Defaults to DIY / FREE /
    /// no addons when omitted — same effective set as legacy orgs
    /// that pre-date plan tracking.
    plan?: {
      plan: "DIY" | "EXPERT"
      tier: "FREE" | "PAID" | null
      addons: readonly string[]
    }
  }): Promise<{
    org: { id: string; name: string }
    integration: { id: string }
  }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          plan: input.plan?.plan ?? "DIY",
          tier: input.plan?.tier ?? null,
          addons:
            input.plan?.addons && input.plan.addons.length > 0
              ? [...input.plan.addons]
              : Prisma.JsonNull,
        },
        select: { id: true, name: true },
      })

      const integration = await tx.apiIntegration.create({
        data: {
          organizationId: org.id,
          name: input.integration.name,
          tokenHash: input.integration.tokenHash,
          tokenPrefix: input.integration.tokenPrefix,
          scopes: [...input.integration.scopes],
          issuedByMasterKeyId: input.integration.issuedByMasterKeyId,
        },
        select: { id: true },
      })

      return { org, integration }
    })

    // Seed defaults outside the tx so a seeding hiccup doesn't roll
    // back the org + integration creation. The seeder is idempotent.
    await this.seedDefaultsForNewOrganization(result.org.id, result.org.name)

    return result
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

  /**
   * Toggle the org's "overtime enabled" master switch. Per-employee
   * policy may further opt individual employees out (`policy.otEnabled`).
   */
  async setOrganizationOtEnabled(
    organizationId: string,
    enabled: boolean,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.organization.update({
      where: { id: organizationId },
      data: { otEnabled: enabled },
    })
  },

  /**
   * Toggle the org's "allow forecasted leave apply" master switch.
   * When true, employees can apply for PRO_RATED leave that hasn't
   * yet accrued provided it will by the leave's start date. When
   * false (default), the strict balance check applies.
   */
  async setOrganizationAllowForecastedLeaveApply(
    organizationId: string,
    enabled: boolean,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.organization.update({
      where: { id: organizationId },
      data: { allowForecastedLeaveApply: enabled },
    })
  },

  /**
   * Persist the org's supervisor-performance reporting settings.
   * `slaMinutes` is the SLA window the admin dashboard uses to flag
   * "slow approvers". Values are assumed pre-validated.
   */
  async setSupervisorReportSettings(
    organizationId: string,
    enabled: boolean,
    slaMinutes: number,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        supervisorReportEnabled: enabled,
        supervisorSlaMinutes: slaMinutes,
      },
    })
  },

  /**
   * Set the org-wide geofence radius (meters). Caller validates the
   * 10–10000 range; this method just writes.
   */
  async setGeofenceRadius(
    organizationId: string,
    meters: number,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.organization.update({
      where: { id: organizationId },
      data: { geofenceRadiusMeters: meters },
    })
  },

  /**
   * Confirm a project belongs to a given organisation. Returns `true`
   * when the row exists with the matching `organizationId`. Used by
   * admin actions to scope-check the target project before mutating it.
   */
  async projectBelongsToOrg(
    projectId: string,
    organizationId: string,
  ): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false
    const row = await prisma.xeroProject.findFirst({
      where: { id: projectId, organizationId },
      select: { id: true },
    })
    return row !== null
  },

  /**
   * Update a project's calendar config (working hours, working days,
   * lunch break). Caller pre-validates the formats; this method just
   * writes. `lunchBreakMinutes: undefined` leaves the existing value
   * untouched (versus null which would clear it).
   */
  async updateProjectCalendar(
    projectId: string,
    values: {
      workingHoursStart: string | null
      workingHoursEnd: string | null
      workingDays: string | null
      lunchBreakMinutes?: number
    },
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.xeroProject.update({
      where: { id: projectId },
      data: {
        workingHoursStart: values.workingHoursStart,
        workingHoursEnd: values.workingHoursEnd,
        workingDays: values.workingDays,
        ...(values.lunchBreakMinutes !== undefined
          ? { lunchBreakMinutes: values.lunchBreakMinutes }
          : {}),
      },
    })
  },

  /**
   * Upsert a single project holiday by `(projectId, date)`. Used for
   * both manual adds and bulk imports — the import loops over this so
   * a single failed row doesn't poison the rest.
   */
  async upsertProjectHoliday(input: {
    projectId: string
    date: Date
    name: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.projectHoliday.upsert({
      where: {
        projectId_date: { projectId: input.projectId, date: input.date },
      },
      create: input,
      update: { name: input.name },
    })
  },

  /**
   * Delete a single project holiday, but only if it belongs to the
   * given org (defence-in-depth against id-guessing). Returns `false`
   * when the holiday doesn't exist or is in a different org — the
   * action surfaces this as "Holiday not found" without leaking which
   * of those two it was.
   */
  async deleteProjectHolidayInOrg(
    holidayId: string,
    organizationId: string,
  ): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false
    const row = await prisma.projectHoliday.findUnique({
      where: { id: holidayId },
      select: { project: { select: { organizationId: true } } },
    })
    if (!row || row.project.organizationId !== organizationId) return false
    await prisma.projectHoliday.delete({ where: { id: holidayId } })
    return true
  },

  async getOrgWorkingDays(organizationId: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { workingDays: true },
    })
    return row?.workingDays ?? null
  },

  async setOrgWorkingDays(organizationId: string, workingDays: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.organization.update({
      where: { id: organizationId },
      data: { workingDays },
    })
  },

  async getOrgHolidays(
    organizationId: string,
  ): Promise<Array<{ id: string; date: string; name: string }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.orgHoliday.findMany({
      where: { organizationId },
      orderBy: { date: "asc" },
      select: { id: true, date: true, name: true },
    })
    return rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      name: r.name,
    }))
  },

  async upsertOrgHoliday(input: {
    organizationId: string
    date: Date
    name: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.orgHoliday.upsert({
      where: {
        organizationId_date: {
          organizationId: input.organizationId,
          date: input.date,
        },
      },
      create: input,
      update: { name: input.name },
    })
  },

  async deleteOrgHoliday(holidayId: string, organizationId: string): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false
    const row = await prisma.orgHoliday.findUnique({
      where: { id: holidayId },
      select: { organizationId: true },
    })
    if (!row || row.organizationId !== organizationId) return false
    await prisma.orgHoliday.delete({ where: { id: holidayId } })
    return true
  },

  /**
   * Persist the org-level currency policy. Caller is expected to have
   * already validated that every code is in the curated catalogue and
   * that defaultCurrency ∈ allowedCurrencies — this method assumes
   * clean input and just writes.
   */
  async updateOrganizationCurrencies(data: {
    organizationId: string
    allowedCurrencies: string[]
    defaultCurrency: string | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.organization.update({
      where: { id: data.organizationId },
      data: {
        allowedCurrencies: data.allowedCurrencies,
        defaultCurrency: data.defaultCurrency,
      },
    })
  },

  async getOrganizationMembers(
    organizationId: string,
    options?: {
      /// Optional employee-policy scope. When non-null, only employees
      /// whose `EmployeeProfile.policyId` is in the list are returned.
      /// Mirrors the same shape as the Claims repo filter so callers can
      /// thread a single `policyIdScope` through.
      policyIdScope?: string[] | null
    },
  ): Promise<OrganizationMember[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      return []
    }

    // The org connects to at most one Xero tenant — resolve it once and
    // attach to every member (the per-row link was removed).
    const orgConnection = await prisma.xeroConnection.findFirst({
      where: { organizationId },
      select: { id: true, tenantName: true },
    })

    // Multi-org: filter by `EmployeeProfile.organizationId`, NOT
    // `User.organizationId`. When an existing user (from Company A) is
    // linked into Company B via the Add-Employee flow, we create a
    // NEW `EmployeeProfile` under Company B but leave `User.organizationId`
    // pointing at Company A (their legacy home org). Filtering on the
    // User's home org would therefore miss them entirely from Company B's
    // employee list — the exact bug this fixes.
    //
    // The include's `employeeProfiles.where` mirrors the same clause so
    // a linked user's Company A profile doesn't leak into Company B's
    // row (mapUser reads `employeeProfiles[0]` — without the scoped
    // include, the wrong-org profile could be picked).
    const rows = await prisma.user.findMany({
      where: {
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: {
          some: {
            organizationId,
            ...(policyIdScope && policyIdScope.length > 0
              ? { policyId: { in: policyIdScope } }
              : {}),
          },
        },
      },
      include: {
        organization: true,
        employeeProfiles: {
          where: { organizationId },
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
            policy: { select: { id: true, name: true, salaryType: true, otEnabled: true, otMethod: true } },
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
      // Multi-org: pick the first EmployeeProfile for this org listing.
      // A future refactor will scope this to the active org id.
      const employeeProfile = user.employeeProfiles[0] ?? null
      const assignedProjects = mapAssignedProjects(
        employeeProfile?.projectAssignments ?? [],
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

      const teams = (employeeProfile?.teamMemberships ?? []).map(
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
        // Surface the EmployeeProfile id so external API consumers can
        // pass it to `POST /api/v1/teams/[id]/members`. UI consumers
        // ignore this field.
        employeeProfileId: employeeProfile?.id,
        name: user.name,
        email: user.email,
        role: user.role as OrganizationMember["role"],
        organizationId: user.organizationId ?? undefined,
        organizationName: user.organization?.name ?? undefined,
        employeeId: employeeProfile?.employeeId ?? "N/A",
        projects: assignedProjects,
        jobTitle: employeeProfile?.jobTitle ?? "Employee",
        payoutMethod: resolveEmployeePayoutMethod(
          user.role as OrganizationMember["role"],
          employeeProfile?.policy?.salaryType,
        ),
        otPayoutMethod:
          employeeProfile?.policy?.otEnabled &&
          employeeProfile.policy.otMethod === "TIME_BANK" &&
          resolveEmployeePayoutMethod(
            user.role as OrganizationMember["role"],
            employeeProfile.policy.salaryType,
          ) === "MONTHLY_BASED"
            ? "TIME_BANK"
            : "CASH",
        otTimeBalanceMin: employeeProfile?.otTimeBalanceMin ?? 0,
        xeroConnectionId: orgConnection?.id ?? undefined,
        xeroConnectionName: orgConnection?.tenantName ?? undefined,
        policyId: employeeProfile?.policy?.id ?? undefined,
        policyName: employeeProfile?.policy?.name ?? undefined,
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
    /// Employee policy assignment. Required: the policy's salaryType
    /// and otMethod drive compensation/OT behavior.
    policyId: string
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
      isAdminRole(targetUser.role) ||
      targetUser.organizationId !== data.organizationId
    ) {
      throw new Error("You can only manage members inside your own organization.")
    }

    const assignedProjects = data.projectIds.length
      ? await prisma.xeroProject.findMany({
          where: {
            id: { in: data.projectIds },
            organizationId: data.organizationId,
            archivedByXeroConnect: false,
          },
          select: { id: true, name: true },
        })
      : []

    if (assignedProjects.length !== data.projectIds.length) {
      throw new Error("Selected projects must belong to this organization.")
    }

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
          if (u.role !== "SUPERVISOR" && u.role !== "ADMIN" && u.role !== "OWNER") {
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

    const profile = await prisma.employeeProfile.findFirst({
      where: { userId: data.userId },
      select: { id: true },
    })
    if (!profile) throw new Error("Employee profile not found.")

    const policy = await prisma.employeePolicy.findFirst({
      where: { id: data.policyId, organizationId: data.organizationId },
      select: { salaryType: true, otMethod: true, archivedAt: true },
    })
    if (!policy) throw new Error("Selected employee policy not found.")
    if (policy.archivedAt) {
      throw new Error("Selected employee policy is archived.")
    }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: data.userId },
        data: { role: data.role, organizationId: data.organizationId },
      })
      await tx.employeeProfile.updateMany({
        where: { userId: data.userId },
        data: {
          jobTitle: data.jobTitle,
          policyId: data.policyId,
        },
      })
      await tx.employeeProjectAssignment.deleteMany({
        where: { employeeProfile: { userId: data.userId } },
      })
      for (const projectId of data.projectIds) {
        await tx.employeeProjectAssignment.create({
          data: {
            employeeProfile: { connect: { id: profile.id } },
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

  /**
   * Find a user by id, scoped to the given org. Used by external API
   * endpoints that accept an `actingUserId` from the caller (e.g. the
   * payroll-run approve endpoint) — we have to verify the user
   * belongs to the integration's organisation before trusting them.
   *
   * Returns null when the user doesn't exist OR belongs to a
   * different org. Both cases collapse to a single "user not found"
   * response on the API surface to avoid leaking which-org-is-which.
   */
  async findOrgMemberById(input: {
    userId: string
    organizationId: string
  }): Promise<{
    id: string
    name: string
    email: string
    role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER"
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const user = await prisma.user.findFirst({
      where: { id: input.userId, organizationId: input.organizationId },
      select: { id: true, name: true, email: true, role: true },
    })
    return user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER",
        }
      : null
  },

  /**
   * Multi-tenant aware lookup for an ADMIN / OWNER who has access to a
   * given organisation. Used by external API endpoints that accept a
   * `acting userId` from the caller (currently the payroll-run approve
   * endpoint) and need to confirm the user can legitimately authorise
   * the action AGAINST THAT ORG.
   *
   * Differs from `findOrgMemberById` in that it accepts BOTH paths an
   * admin uses to gain access to an org:
   *
   *   1. Primary org    — `User.organizationId === orgId`
   *   2. Linked admin   — `AdminOrganization { adminId, organizationId }`
   *   3. Xero connector — the admin who connected Xero for the org
   *
   * (Same three checks the in-app `isAdminOfOrganization()` helper
   * uses for session-based access decisions, so admins see consistent
   * behaviour between the UI and the partner API.)
   *
   * Returns null when the user doesn't exist, isn't an admin/owner,
   * or has no access to the org. The caller maps null → 403 with a
   * single generic message (don't enumerate which condition failed —
   * leaks org membership).
   */
  async findAdminWithAccessToOrg(input: {
    userId: string
    organizationId: string
  }): Promise<{
    id: string
    name: string
    email: string
    role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER"
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    // Look up the user by id (no org filter yet — the user might be
    // an admin whose primary org is X but who has been linked to Y).
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, name: true, email: true, role: true },
    })
    if (!user) return null

    const role = user.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER"
    if (!isAdminRole(role)) return null

    // Reuse the canonical access check so the partner API and the
    // in-app session-based checks stay in lockstep (including the
    // Xero-connector path).
    const hasAccess = await this.isAdminOfOrganization(
      input.userId,
      input.organizationId,
    )
    if (!hasAccess) return null

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role,
    }
  },

  /**
   * Headcount of "active" employees in the org, used by the external
   * `/api/v1/employees/active-count` endpoint.
   *
   * "Active" = EMPLOYEE or SUPERVISOR role, NOT archived from payroll.
   * Specifically:
   *   - Users without a PayrollProfile yet (just-added, pre-payroll
   *     onboarding) count as active.
   *   - Users with PayrollProfile.isArchived = true are EXCLUDED.
   *
   * The query uses `NOT { ... isArchived: true }` rather than the
   * inverse OR clause because the negation naturally covers the
   * "no profile" branch and reads cleanly.
   */
  async countActiveEmployees(organizationId: string): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) return 0
    // Multi-org: count users who hold at least one non-archived
    // EmployeeProfile at THIS org. Filtering on `User.organizationId`
    // would miss linked users (their home org is a different one).
    return prisma.user.count({
      where: {
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: {
          some: {
            organizationId,
            OR: [
              { payrollProfile: null },
              { payrollProfile: { isArchived: false } },
            ],
          },
        },
      },
    })
  },

  /// Next auto-assigned employee code for an org, of the form E001, E002…
  /// Scans existing E-prefixed codes and increments the highest. Used by the
  /// v1 create endpoint when the caller doesn't supply an employeeId.
  async generateNextEmployeeId(organizationId: string): Promise<string> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const rows = await prisma.employeeProfile.findMany({
      where: { user: { organizationId }, employeeId: { startsWith: "E" } },
      select: { employeeId: true },
    })
    let max = 0
    for (const r of rows) {
      const m = /^E(\d+)$/.exec(r.employeeId)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return `E${String(max + 1).padStart(3, "0")}`
  },

  /// Resolve the policy to use for a new employee: the given id, or the org's
  /// default policy when none is supplied. Returns its id and translated
  /// SalaryType (EmployeePolicy.salaryType is the PayoutMethod enum).
  async resolvePolicyForCreate(
    organizationId: string,
    policyId?: string | null,
  ): Promise<{ id: string; salaryType: "MONTHLY" | "HOURLY" }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    let id = policyId ?? null
    if (!id) {
      const def = await policyRepository.findDefault(organizationId)
      if (!def) {
        throw new Error("No default employee policy configured for this organization.")
      }
      id = def.id
    }
    const policy = await prisma.employeePolicy.findFirst({
      where: { id, organizationId },
      select: { id: true, salaryType: true, archivedAt: true },
    })
    if (!policy) throw new Error("Selected employee policy not found.")
    if (policy.archivedAt) throw new Error("Selected employee policy is archived.")
    return { id: policy.id, salaryType: policy.salaryType === "HOURLY" ? "HOURLY" : "MONTHLY" }
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
    /// Employee policy assignment. Required: the policy's salaryType
    /// and otMethod drive compensation/OT behavior.
    policyId: string
    /// Optional phone — used by the forgot-password WhatsApp delivery
    /// when present. Stored on PayrollProfile.phone, which we eagerly
    /// create here even though payroll-onboarding hasn't happened yet,
    /// so the password-reset lookup works from day one when a number
    /// IS supplied. Empty string → null on the profile (admin will
    /// share the temporary password manually instead). The rest of the
    /// PayrollProfile stays empty until payroll enrollment.
    phone: string
    /// Optional first-day-of-work date. Stored on `PayrollProfile.joinDate`.
    /// MUST be written before `seedEmployeeLeaveEntitlements` runs so the
    /// PRO_RATED seed path can read it and pro-rate this year's accrual.
    /// Null = unknown; PRO_RATED entitlements fall back to full entitlement
    /// and admin can fix by setting joinDate on the edit page later
    /// (triggers `recomputeProRatedAccrualForEmployee`).
    joinDate?: Date | null
    /// Optional date of birth (YYYY-MM-DD string). Saved to
    /// PayrollProfile.dateOfBirth so the Personal tab is pre-filled.
    dob?: string
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
    /// Drives the eager LeaveEntitlement creation that happens at the
    /// end of this method. Default = `{ method: "DEFAULT" }` which
    /// seeds one row per active leave type using the resolved policy /
    /// type defaults. `CUSTOM` lets the Add Employee dialog pass
    /// admin-typed per-type day counts and accrual-method overrides.
    leaveSeed?: LeaveSeedInput
    /// Optional extra PayrollProfile fields (personal/spouse/children/
    /// statutory/compensation) written right after the profile is created.
    /// Used by the v1 create-employee API. Excludes phone/salaryType/joinDate/
    /// dateOfBirth which are set from the dedicated params above.
    payroll?: Prisma.PayrollProfileUpdateInput
  }): Promise<{ id: string; linkedExistingUser?: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    // Multi-org linking: before we validate email-uniqueness the
    // strict way (which would reject a rejoin), check whether the
    // email belongs to an ACTIVE portal user who does NOT already have
    // an EmployeeProfile at this org. If so, we link them into this
    // org — same auth (email + existing password), new profile at
    // this company. This is what makes a "same person at 2 companies"
    // flow work: Company B's admin fills the Add Employee form as
    // usual, and the system quietly links instead of duplicating.
    //
    // We keep the existing User's name/role/password untouched. If
    // Company B's admin picked a different role from Company A's,
    // Company A's role wins — role is currently a User-level scalar,
    // so it can't diverge per-org. Surface this in the audit trail.
    const linkable = await findLinkableExistingUserForOrgInternal({
      prisma,
      email: data.email,
      organizationId: data.organizationId,
    })

    const existingEmployeeProfile = linkable
      ? // For the link path, employeeId collisions still matter — the
        // admin might reuse an ID that's already taken at THIS org.
        await prisma.employeeProfile.findFirst({
          where: { employeeId: data.employeeId, organizationId: data.organizationId },
          select: { id: true },
        })
      : await prisma.employeeProfile.findFirst({
          where: {
            employeeId: data.employeeId,
            user: { organizationId: data.organizationId },
          },
          select: { id: true },
        })

    if (existingEmployeeProfile) {
      throw new Error("That employee ID is already assigned to another user.")
    }

    // Email-uniqueness gate — replaces the dropped @unique on User.email.
    // Only runs for the NEW-user path. When we're linking an existing
    // user, this check would (correctly) throw IN_USE_ACTIVE — but
    // that's precisely the case we want to handle by linking.
    if (!linkable) {
      await assertEmailAvailableForNewUser({
        email: data.email,
        orgId: data.organizationId,
      })
    }

    const assignedProjects = data.projectIds.length
      ? await prisma.xeroProject.findMany({
          where: {
            id: { in: data.projectIds },
            organizationId: data.organizationId,
            archivedByXeroConnect: false,
          },
          select: { id: true, name: true },
        })
      : []

    if (assignedProjects.length !== data.projectIds.length) {
      throw new Error("Selected projects must belong to this organization.")
    }

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
          if (u.role !== "SUPERVISOR" && u.role !== "ADMIN" && u.role !== "OWNER") {
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

    const policy = await prisma.employeePolicy.findFirst({
      where: { id: data.policyId, organizationId: data.organizationId },
      select: { salaryType: true, otMethod: true, archivedAt: true },
    })
    if (!policy) throw new Error("Selected employee policy not found.")
    if (policy.archivedAt) {
      throw new Error("Selected employee policy is archived.")
    }
    // Eagerly create the PayrollProfile so the forgot-password lookup
    // (which traverses EmployeeProfile → PayrollProfile.phone) succeeds
    // for newly-added employees who haven't been onboarded into payroll
    // yet. Everything except `phone` stays empty/default — the run
    // readiness checks still treat the profile as incomplete until
    // payroll enrolment populates the rest of the fields.
    // Empty / whitespace-only → null on PayrollProfile.phone (column
    // is `String?`). Forgot-password flow then can't reach the user
    // by WhatsApp, by design.
    const phoneRaw = data.phone.trim()
    const phoneTrimmed = phoneRaw.length > 0 ? phoneRaw : null

    // Shared payload for the EmployeeProfile — same shape whether we
    // nest it under a fresh User.create or create it directly under
    // an existing user (link path).
    const employeeProfileCreatePayload = {
      organizationId: data.organizationId,
      employeeId: data.employeeId,
      jobTitle: data.jobTitle,
      preferredCurrency: "USD",
      policyId: data.policyId,
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
      payrollProfile: {
        create: {
          phone: phoneTrimmed,
          // PayrollProfile requires `salaryType` and
          // `payrollDocuments` on first create. Seed `salaryType`
          // from the chosen policy so it matches what the admin
          // selected; `payrollDocuments` is an empty JSON array
          // until the admin uploads contracts during payroll
          // onboarding. `monthlySalary` / `hourlyRate` stay null
          // — the payroll-readiness service treats that as "not
          // yet enrolled in payroll".
          // EmployeePolicy.salaryType is the PayoutMethod enum
          // (HOURLY | MONTHLY_BASED), while PayrollProfile.salaryType
          // is the SalaryType enum (HOURLY | MONTHLY). Translate.
          salaryType: policy.salaryType === "HOURLY" ? "HOURLY" : "MONTHLY",
          // joinDate landed here (before seedEmployeeLeaveEntitlements
          // runs) so the PRO_RATED seed path can read it via
          // `leaveRepository.getEmployeeJoinDate` and compute the
          // initial accrual against the actual hire date.
          joinDate: data.joinDate ?? null,
          dateOfBirth: data.dob ? new Date(data.dob) : null,
          payrollDocuments: [],
        },
      },
    } as const

    let user: { id: string; employeeProfiles: Array<{ id: string }> }
    if (linkable) {
      // LINK PATH: reuse the existing User, add a fresh EmployeeProfile
      // at THIS org. Password / role / name stay whatever they are on
      // the existing User. The @@unique([userId, organizationId])
      // on EmployeeProfile makes this create safe under concurrent
      // add-employee attempts.
      const profile = await prisma.employeeProfile.create({
        data: {
          userId: linkable.id,
          ...employeeProfileCreatePayload,
        },
        select: { id: true, userId: true },
      })
      user = { id: linkable.id, employeeProfiles: [{ id: profile.id }] }
    } else {
      // NEW-USER PATH: same as before. `organizationId` on the User
      // becomes the "home org" — kept for legacy call-sites (see the
      // repo-wide multi-org rollout notes).
      user = await prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          passwordHash: hashPassword(data.password),
          role: data.role,
          organizationId: data.organizationId,
          employeeProfiles: {
            create: employeeProfileCreatePayload,
          },
        },
        select: { id: true, employeeProfiles: { select: { id: true } } },
      })
    }

    const newEmployeeProfile = user.employeeProfiles[0] ?? null

    // ALWAYS create the EmployeeOrganization membership row — this is
    // the source of truth for the multi-org login picker + the
    // employee shell's "Switch Company" button. Pre-multi-org callers
    // never wrote this row; the Phase 1a backfill covered historical
    // rows, and this line covers everyone created from here on.
    if (newEmployeeProfile?.id) {
      await prisma.employeeOrganization.create({
        data: {
          userId: user.id,
          employeeProfileId: newEmployeeProfile.id,
          organizationId: data.organizationId,
        },
      })
    }

    // Apply the optional extra PayrollProfile fields (v1 create API). Done as a
    // follow-up update so the nested create above stays minimal; joinDate is
    // already set in the create so leave seeding below still sees it.
    if (data.payroll && newEmployeeProfile?.id) {
      await prisma.payrollProfile.update({
        where: { employeeProfileId: newEmployeeProfile.id },
        data: data.payroll,
      })
    }

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

    // Eagerly seed leave entitlements so the new employee has rows
    // for every active leave type from day one — closes the
    // lazy-creation gap where carry-forward could silently vanish at
    // year-end if no one had visited the employee's leave page yet.
    // `leaveSeed` defaults to DEFAULT so existing non-dialog callers
    // (partner API, payroll XLSX import) get the same eager seeding
    // without code changes on their side.
    if (newEmployeeProfile?.id) {
      await seedEmployeeLeaveEntitlements({
        employeeProfileId: newEmployeeProfile.id,
        leaveSeed: data.leaveSeed ?? { method: "DEFAULT" },
      })
    }

    return {
      id: user.id,
      ...(linkable ? { linkedExistingUser: true as const } : {}),
    }
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
        if (approver.role !== "SUPERVISOR" && approver.role !== "ADMIN" && approver.role !== "OWNER") {
          throw new Error("Approvers must be supervisors or admins.")
        }
      }

      if (approvers.length !== data.approverIds.length) {
        throw new Error("One or more approvers could not be found.")
      }
    }

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
    ])
  },

  // ---------------------------------------------------------------------------
  // XeroConnection queries
  // ---------------------------------------------------------------------------

  async getXeroConnections(organizationId: string): Promise<XeroConnectionInfo[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const requiredReauth = getXeroReauthVersion()

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
        reauthorizedAt: true,
        lastReauthVersion: true,
      },
    })

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      tenantType: row.tenantType ?? undefined,
      connectedAt: (row.reauthorizedAt ?? row.createdAt).toISOString(),
      lastTokenRefreshAt: row.updatedAt.toISOString(),
      requiresReauth: Boolean(requiredReauth) && row.lastReauthVersion !== requiredReauth,
    }))
  },

  /**
   * The org's single active Xero connection id (or null). An
   * organization connects to at most one Xero tenant, so synced data
   * and file access resolve the connection from the org rather than
   * carrying a per-row `xeroConnectionId`.
   */
  async getActiveXeroConnectionId(
    organizationId: string,
  ): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.xeroConnection.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    return row?.id ?? null
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

    const requiredReauth = getXeroReauthVersion()

    const rows = await prisma.xeroConnection.findMany({
      where: { organizationId },
      select: {
        id: true,
        tenantId: true,
        tenantName: true,
        tenantType: true,
        createdAt: true,
        updatedAt: true,
        reauthorizedAt: true,
        lastReauthVersion: true,
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
        connectedAt: (row.reauthorizedAt ?? row.createdAt).toISOString(),
        lastTokenRefreshAt: row.updatedAt.toISOString(),
        requiresReauth: Boolean(requiredReauth) && row.lastReauthVersion !== requiredReauth,
      })),
    }
  },

  async upsertXeroConnection(data: {
    organizationId: string
    tenantId: string
    /// Xero's connection ID (the `id` field returned by GET /connections).
    /// Required for the disconnect flow to actually revoke on Xero's side.
    xeroConnectionId: string
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

    // Stamp the just-completed OAuth flow with the developer's current
    // reauth tag (if set). On any future bump of XERO_REAUTH_VERSION the
    // mismatch will surface the "Update permissions" button until the
    // admin re-runs the flow. Null means the feature is currently disabled
    // in this deployment — we still write null so old marks don't leak
    // through after the env var is cleared.
    const reauthVersion = getXeroReauthVersion()
    const now = new Date()

    // Detect a fresh connect vs a reauth ("Update permissions") on an
    // existing connection — we only archive pre-existing custom rows on
    // the FIRST connect, so custom accounts/projects created during the
    // connected period (or a reauth) stay visible.
    const existingConnection = await prisma.xeroConnection.findUnique({
      where: { organizationId: data.organizationId },
      select: { id: true },
    })

    await prisma.xeroConnection.upsert({
      // One connection per org (organizationId is unique). Reconnecting —
      // even to a different tenant — updates the single row in place.
      where: {
        organizationId: data.organizationId,
      },
      create: {
        provider: "xero",
        organizationId: data.organizationId,
        tenantId: data.tenantId,
        xeroConnectionId: data.xeroConnectionId,
        tenantName: data.tenantName,
        tenantType: data.tenantType,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        connectedByAdminId: data.connectedByAdminId,
        reauthorizedAt: now,
        lastReauthVersion: reauthVersion,
      },
      update: {
        tenantId: data.tenantId,
        xeroConnectionId: data.xeroConnectionId,
        tenantName: data.tenantName,
        tenantType: data.tenantType,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        tokenType: data.tokenType,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        connectedByAdminId: data.connectedByAdminId,
        reauthorizedAt: now,
        lastReauthVersion: reauthVersion,
      },
    })

    // First connect → archive pre-existing custom accounts + manual
    // projects so they drop out of selectable lists/pickers while Xero
    // is the source of truth. Restored on disconnect (deleteXeroConnection).
    if (!existingConnection) {
      await prisma.chartOfAccount.updateMany({
        where: { organizationId: data.organizationId, isCustom: true },
        data: { archivedByXeroConnect: true },
      })
      await prisma.xeroProject.updateMany({
        where: { organizationId: data.organizationId, isManual: true },
        data: { archivedByXeroConnect: true },
      })
    }
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

    // Synced accounts + projects used to be removed via the
    // `onDelete: Cascade` FK on their (now-dropped) `xeroConnectionId`
    // column. With the FK gone, clean them up explicitly here — but only
    // the Xero-synced rows: custom accounts (`isCustom`) and manual
    // projects (`isManual`) are admin-authored and must survive a
    // disconnect.
    const result = await prisma.$transaction(async (tx) => {
      await tx.chartOfAccount.deleteMany({
        where: { organizationId: data.organizationId, isCustom: false },
      })
      await tx.xeroProject.deleteMany({
        where: { organizationId: data.organizationId, isManual: false },
      })
      // Restore the custom accounts + manual projects that were hidden
      // while Xero was connected, so they reappear in the UI now.
      await tx.chartOfAccount.updateMany({
        where: { organizationId: data.organizationId, archivedByXeroConnect: true },
        data: { archivedByXeroConnect: false },
      })
      await tx.xeroProject.updateMany({
        where: { organizationId: data.organizationId, archivedByXeroConnect: true },
        data: { archivedByXeroConnect: false },
      })
      return tx.xeroConnection.deleteMany({
        where: {
          id: data.connectionId,
          organizationId: data.organizationId,
        },
      })
    })

    return result.count > 0
  },

  // ---------------------------------------------------------------------------
  // Chart of Accounts
  // ---------------------------------------------------------------------------

  async getChartAccountsForConnection(connectionId: string): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Accounts are org-scoped (one Xero connection per org). Resolve the
    // org from the connection, then list its accounts.
    const conn = await prisma.xeroConnection.findUnique({
      where: { id: connectionId },
      select: { organizationId: true },
    })
    if (!conn) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId: conn.organizationId, isDisabled: false, archivedByXeroConnect: false },
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

    // An organization has at most ONE active Xero connection at a time,
    // and disconnecting cascade-deletes that connection's
    // `ChartOfAccount` rows (schema: `onDelete: Cascade`). So at any
    // moment the org holds exactly one connection's accounts (or only
    // custom accounts when not connected) — never a mix of stale +
    // live. That makes a plain org-level filter both correct and the
    // simplest option: it returns the live connection's selectable
    // accounts when connected, or the custom selectable accounts when
    // not.
    //
    // The `xeroConnectionId` argument is retained for call-site
    // compatibility but no longer needed for correctness — scoping by
    // org gives the same result and avoids the "employee not assigned
    // to the connection → sees nothing" bug.
    void data.xeroConnectionId
    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        isSelectable: true,
        isDisabled: false,
        archivedByXeroConnect: false,
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
        archivedByXeroConnect: false,
      },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  async getChartAccountsForOrganization(organizationId: string): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId, isDisabled: false, archivedByXeroConnect: false },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows.map((row) => mapChartAccount(row)!)
  },

  /**
   * Lightweight projection of every Xero-linked Chart of Account for
   * an org, returning the raw `xeroAccountId` so the Xero-mapping
   * settings form can render dropdowns without a live Xero API call.
   *
   * Only includes accounts that are synced from a Xero connection
   * (i.e. have a non-null `xeroAccountId`) — custom-only accounts
   * can't be used for Xero postings.
   */
  async getXeroLinkedChartAccountsForOrganization(
    organizationId: string,
  ): Promise<
    Array<{
      xeroAccountId: string
      code: string
      name: string
      /** Xero account type (EXPENSE / LIABILITY / etc). Used by the
       *  settings UI to filter accrual vs expense pickers. */
      type: string | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId,
        isDisabled: false,
        xeroAccountId: { not: null },
      },
      select: { xeroAccountId: true, code: true, name: true, type: true },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })

    return rows
      .filter((r): r is { xeroAccountId: string; code: string; name: string; type: string | null } =>
        Boolean(r.xeroAccountId),
      )
      .map((r) => ({
        xeroAccountId: r.xeroAccountId,
        code: r.code,
        name: r.name,
        type: r.type ?? null,
      }))
  },

  async getCustomChartAccountsForOrganization(
    organizationId: string
  ): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.chartOfAccount.findMany({
      where: { organizationId, isDisabled: false, archivedByXeroConnect: false },
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
        archivedByXeroConnect: false,
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

    // Org-level filter — same rationale as
    // `getSelectableChartAccountsForEmployee`: one active Xero
    // connection per org at a time + cascade-delete on disconnect means
    // org scoping returns exactly the live connection's mileage
    // accounts (or custom ones when not connected).
    void data.xeroConnectionId
    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        allowMileageClaim: true,
        isDisabled: false,
        archivedByXeroConnect: false,
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

  /// Flip a single custom account's `isSelectable` flag without
  /// touching code/name/type. Used by the inline Selectable toggle in
  /// the Custom claim accounts list — easier than re-passing the full
  /// row through `updateCustomChartAccount` from the client.
  async setCustomChartAccountSelectable(data: {
    id: string
    organizationId: string
    isSelectable: boolean
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.chartOfAccount.updateMany({
      where: { id: data.id, organizationId: data.organizationId, isCustom: true },
      data: { isSelectable: data.isSelectable },
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
            organizationId_xeroAccountId: {
              organizationId: data.organizationId,
              xeroAccountId: account.xeroAccountId,
            },
          },
          create: {
            organizationId: data.organizationId,
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

    // Org-level scope (one active connection per org). Reset every
    // account in the org then set the ticked ones — symmetric with the
    // org-level employee display so admin + employee always agree. The
    // `xeroConnectionId` argument is retained for call-site compat.
    void data.xeroConnectionId
    const scopeWhere = { organizationId: data.organizationId }

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

    // Org-level scope (one active connection per org). See
    // `setSelectableChartAccounts` for rationale.
    void data.xeroConnectionId
    const scopeWhere = { organizationId: data.organizationId }

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

  async getSelectedBankAccountsForOrganization(data: {
    organizationId: string
    xeroConnectionId?: string
  }): Promise<ChartOfAccountOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Org-level filter (one active Xero connection per org + cascade-
    // delete on disconnect). Previously this fell back to
    // `xeroConnectionId: null` for unassigned employees, which hid
    // Xero-linked bank accounts the same way the selectable-accounts
    // query did.
    void data.xeroConnectionId
    const rows = await prisma.chartOfAccount.findMany({
      where: {
        organizationId: data.organizationId,
        type: "BANK",
        isBankAccount: true,
        isDisabled: false,
        archivedByXeroConnect: false,
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

    // Org-level scope (one active connection per org). See
    // `setSelectableChartAccounts` for rationale.
    void data.xeroConnectionId
    const scopeWhere = { organizationId: data.organizationId, type: "BANK" }

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

  async getProjectsForConnection(connectionId: string): Promise<OrganizationProjectOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Projects are org-scoped (one Xero connection per org). Resolve the
    // org AND the currently-active tracking category from the
    // connection so we can scope the listing — see the where clause
    // below for why.
    const conn = await prisma.xeroConnection.findUnique({
      where: { id: connectionId },
      select: { organizationId: true, xeroTrackingCategoryId: true },
    })
    if (!conn) return []

    const rows = await prisma.xeroProject.findMany({
      where: {
        organizationId: conn.organizationId,
        isDisabled: false,
        archivedByXeroConnect: false,
        // Scope to the connection's CURRENTLY-active tracking category
        // so swapping the source category in Settings hides stale rows
        // from the prior category without deleting them. Manual rows
        // and legacy `/Projects`-API rows have `xeroTrackingOptionId
        // = NULL` and are always visible (the OR-branch). When no
        // category is picked at all, every row shows — same as before.
        ...(conn.xeroTrackingCategoryId
          ? {
              OR: [
                { xeroTrackingCategoryId: conn.xeroTrackingCategoryId },
                { xeroTrackingOptionId: null },
              ],
            }
          : {}),
      },
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
      projectManagerId: row.projectManagerId ?? undefined,
      projectManagerName: row.projectManager?.name ?? undefined,
      projectManagers: row.projectManagers.map((pm) => ({
        userId: pm.user.id,
        name: pm.user.name,
      })),
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      allowedIps: row.allowedIps ?? null,
      isManual: row.isManual,
    }))
  },

  async listTeamsForOrganization(
    organizationId: string,
    projectId?: string | null,
  ): Promise<
    Array<{
      id: string
      name: string
      projectId: string
      projectName: string
      /** Max hierarchy layer this team supports (1..10). */
      layerCount: number
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.team.findMany({
      where: {
        project: { organizationId, isDisabled: false },
        ...(projectId ? { projectId } : {}),
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: [{ project: { name: "asc" } }, { name: "asc" }],
    })
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      projectId: t.projectId,
      projectName: t.project.name,
      layerCount: t.layerCount,
    }))
  },

  async getProjectsForOrganization(organizationId: string): Promise<OrganizationProjectOption[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Match `getProjectsForConnection`'s scoping: only surface rows
    // that belong to the org's currently-active tracking category.
    // The org may have at most one Xero connection — pick its active
    // category id. Manual / legacy rows (xeroTrackingOptionId = NULL)
    // are always visible.
    const activeConnection = await prisma.xeroConnection.findFirst({
      where: { organizationId },
      select: { xeroTrackingCategoryId: true },
    })
    const activeCategory = activeConnection?.xeroTrackingCategoryId ?? null

    const rows = await prisma.xeroProject.findMany({
      where: {
        organizationId,
        isDisabled: false,
        archivedByXeroConnect: false,
        ...(activeCategory
          ? {
              OR: [
                { xeroTrackingCategoryId: activeCategory },
                { xeroTrackingOptionId: null },
              ],
            }
          : {}),
      },
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
      projectManagerId: row.projectManagerId ?? undefined,
      projectManagerName: row.projectManager?.name ?? undefined,
      projectManagers: row.projectManagers.map((pm) => ({
        userId: pm.user.id,
        name: pm.user.name,
      })),
      location: row.location ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      allowedIps: row.allowedIps ?? null,
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
        if (pm.role !== "SUPERVISOR" && pm.role !== "ADMIN" && pm.role !== "OWNER") {
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
    /// Comma-separated IPv4 allowlist for the clock-in IP-whitelist
    /// check. `undefined` = leave unchanged; `null` or empty = clear.
    allowedIps?: string | null
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
          if (pm.role !== "SUPERVISOR" && pm.role !== "ADMIN" && pm.role !== "OWNER") {
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
          ...(data.allowedIps !== undefined
            ? { allowedIps: data.allowedIps }
            : {}),
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

  /**
   * Remove a single employee from a project. Drops the
   * `EmployeeProjectAssignment` row + any
   * `EmployeeTeamMembership` rows in teams that belong to the project
   * + any approval-chain rows tied to those team memberships. The whole
   * thing runs in one transaction so the row set never ends up half-
   * deleted.
   *
   * Idempotent — re-removing an already-removed assignment is a no-op.
   * Used by the company-structure UI's "Unassigned employees" section to
   * back out an employee that was added by mistake.
   */
  async removeEmployeeFromProject(data: {
    organizationId: string
    employeeProfileId: string
    projectId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    // Verify both rows belong to the org before mutating.
    const [profile, project] = await Promise.all([
      prisma.employeeProfile.findFirst({
        where: { id: data.employeeProfileId },
        select: {
          id: true,
          userId: true,
          user: { select: { organizationId: true } },
        },
      }),
      prisma.xeroProject.findFirst({
        where: { id: data.projectId, organizationId: data.organizationId },
        select: { id: true },
      }),
    ])

    if (!profile || profile.user.organizationId !== data.organizationId) {
      throw new Error("Employee not found in this organization.")
    }
    if (!project) {
      throw new Error("Project not found in this organization.")
    }

    // Find all team memberships this employee has in teams that belong
    // to the project we're removing them from.
    const memberships = await prisma.employeeTeamMembership.findMany({
      where: {
        employeeProfileId: data.employeeProfileId,
        team: { projectId: data.projectId },
      },
      select: { id: true, teamId: true },
    })

    await prisma.$transaction([
      // Chain rows are keyed on (teamId, employeeId=userId). Drop those
      // first so we don't leave dangling approver references.
      prisma.approvalChainStep.deleteMany({
        where: {
          employeeId: profile.userId,
          teamId: { in: memberships.map((m) => m.teamId) },
        },
      }),
      prisma.employeeTeamMembership.deleteMany({
        where: { id: { in: memberships.map((m) => m.id) } },
      }),
      prisma.employeeProjectAssignment.deleteMany({
        where: {
          employeeProfileId: data.employeeProfileId,
          projectId: data.projectId,
        },
      }),
    ])
  },

  /**
   * Add a single employee to a project (creates an
   * `EmployeeProjectAssignment` row). Idempotent — re-adding an existing
   * assignment is a no-op thanks to the unique constraint
   * `(employeeProfileId, projectId)`. The team-membership / chain rows
   * are NOT touched here; team assignment happens separately via
   * `assignTeamMember`. Used by the company-structure UI's "Add employee
   * to project" affordance.
   *
   * Throws when the profile or project don't exist in this organization
   * — that's a real data error, not an idempotent retry.
   */
  async addEmployeeToProject(data: {
    organizationId: string
    employeeProfileId: string
    projectId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const [profile, project] = await Promise.all([
      prisma.employeeProfile.findFirst({
        where: { id: data.employeeProfileId },
        select: { id: true, user: { select: { organizationId: true } } },
      }),
      prisma.xeroProject.findFirst({
        where: { id: data.projectId, organizationId: data.organizationId },
        select: { id: true },
      }),
    ])

    if (!profile || profile.user.organizationId !== data.organizationId) {
      throw new Error("Employee not found in this organization.")
    }
    if (!project) {
      throw new Error("Project not found in this organization.")
    }

    // Upsert keyed on the unique pair so re-adding is a no-op.
    await prisma.employeeProjectAssignment.upsert({
      where: {
        employeeProfileId_projectId: {
          employeeProfileId: data.employeeProfileId,
          projectId: data.projectId,
        },
      },
      create: {
        employeeProfileId: data.employeeProfileId,
        projectId: data.projectId,
      },
      update: {},
    })
  },

  /**
   * Hard-delete an employee/supervisor from an organization. Removes the
   * `User` row, which cascades through EmployeeProfile,
   * EmployeeProjectAssignment, EmployeeTeamMembership, and any chain rows
   * that reference the user. Used by the external API's
   * `DELETE /api/v1/employees/[id]`.
   *
   * Org-scoped: returns `{ ok: false }` if the user isn't a member of the
   * given organization (either by `User.organizationId` or via a join
   * row), so a partner token can't reach into another tenant's data by
   * guessing user ids.
   */
  async deleteOrganizationMember(input: {
    userId: string
    organizationId: string
  }): Promise<{ ok: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false }

    // Ownership check — the user must belong to this org. We accept
    // either `organizationId` set directly OR an AdminOrganization join
    // row pointing at the org (multi-org admins). Employees only ever
    // have the direct column set.
    const user = await prisma.user.findFirst({
      where: {
        id: input.userId,
        OR: [
          { organizationId: input.organizationId },
          { adminOrganizations: { some: { organizationId: input.organizationId } } },
        ],
      },
      select: { id: true, role: true },
    })
    if (!user) return { ok: false }

    // Refuse to delete an ADMIN through this method — admins are managed
    // through the multi-admin flow, not the employees endpoint. Letting
    // the partner accidentally nuke an admin via the wrong endpoint
    // would be very bad.
    if (isAdminRole(user.role)) return { ok: false }

    await prisma.user.delete({ where: { id: user.id } })
    return { ok: true }
  },

  /**
   * Upsert tracking-category OPTIONS as XeroProject rows. Keyed by
   * `xeroTrackingOptionId` (the second unique constraint on
   * XeroProject). Coexists with legacy `xeroProjectId` rows — both
   * can live in the same table.
   *
   * Used by `syncOrganizationProjects` after the admin picks a
   * tracking category in settings. Legacy rows from the old
   * `/Projects` API sync stay untouched.
   */
  async upsertTrackingOptionsFromXero(data: {
    xeroConnectionId: string
    organizationId: string
    /// The Xero Tracking Category these options belong to. Stamped on
    /// every upserted row so the project-listing queries can scope by
    /// the connection's currently-active category and hide stale rows
    /// from a previous category without deleting them.
    xeroTrackingCategoryId: string
    options: Array<{
      xeroTrackingOptionId: string
      name: string
      status?: string
    }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await Promise.all(
      data.options.map((opt) =>
        prisma.xeroProject.upsert({
          where: {
            organizationId_xeroTrackingOptionId: {
              organizationId: data.organizationId,
              xeroTrackingOptionId: opt.xeroTrackingOptionId,
            },
          },
          create: {
            organizationId: data.organizationId,
            xeroTrackingOptionId: opt.xeroTrackingOptionId,
            xeroTrackingCategoryId: data.xeroTrackingCategoryId,
            name: opt.name,
            status: opt.status,
            isManual: false,
          },
          update: {
            name: opt.name,
            status: opt.status,
            // Re-stamp on update too, so any row that was synced
            // before the column existed (and therefore has
            // xeroTrackingCategoryId = NULL) gets backfilled the
            // first time it re-appears in a sync.
            xeroTrackingCategoryId: data.xeroTrackingCategoryId,
          },
        }),
      ),
    )
  },

  /**
   * Persist the admin's tracking-category pick on the XeroConnection.
   * Caches the display name so the settings UI can show it without
   * round-tripping Xero. Pass `null` for both to clear the pick.
   */
  async setXeroTrackingCategory(data: {
    connectionId: string
    xeroTrackingCategoryId: string | null
    xeroTrackingCategoryName: string | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }
    await prisma.xeroConnection.update({
      where: { id: data.connectionId },
      data: {
        xeroTrackingCategoryId: data.xeroTrackingCategoryId,
        xeroTrackingCategoryName: data.xeroTrackingCategoryName,
      },
    })
  },

  async upsertProjectsFromXero(data: {
    xeroConnectionId: string
    organizationId: string
    projects: Array<{
      xeroProjectId: string
      name: string
      status?: string
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
            organizationId_xeroProjectId: {
              organizationId: data.organizationId,
              xeroProjectId: project.xeroProjectId,
            },
          },
          create: {
            organizationId: data.organizationId,
            xeroProjectId: project.xeroProjectId,
            name: project.name,
            status: project.status,
            isManual: false,
          },
          update: {
            name: project.name,
            status: project.status,
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

    const profile = await prisma.employeeProfile.findFirst({
      where: { userId: employeeUserId },
      select: {
        id: true,
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

  /**
   * Same shape as `getTeam()` but for every team in the org. Used by the
   * admin company-structure page so we can render team rosters inline
   * without N+1 round-trips. One query, joins everything in.
   */
  async listTeamsWithMembers(organizationId: string): Promise<TeamDetail[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.team.findMany({
      where: { project: { organizationId } },
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
      orderBy: [{ project: { name: "asc" } }, { name: "asc" }],
    })

    return rows.map((row) => {
      const summary = mapTeamSummary({
        ...row,
        _count: { memberships: row.memberships.length },
      })
      const members: TeamMembership[] = row.memberships.map((m) => ({
        id: m.id,
        employeeProfileId: m.employeeProfileId,
        userId: m.employeeProfile.userId,
        name: m.employeeProfile.user.name,
        role:
          m.employeeProfile.user.role === "SUPERVISOR"
            ? "SUPERVISOR"
            : "EMPLOYEE",
        layer: m.layer,
        teamId: m.teamId,
      }))
      return { ...summary, members }
    })
  },

  async createTeam(data: {
    organizationId: string
    projectId: string
    name: string
    layerCount: number
    moduleConfig?: TeamModuleConfig
    layerLabels?: string[] | null
    /// Per-event approval gates. Omitted → DB defaults (all true) apply,
    /// matching the previous always-approve behaviour.
    requireClockInApproval?: boolean
    requireClockOutApproval?: boolean
    requireBreakStartApproval?: boolean
    requireBreakEndApproval?: boolean
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
        ...(data.requireClockInApproval !== undefined
          ? { requireClockInApproval: data.requireClockInApproval }
          : {}),
        ...(data.requireClockOutApproval !== undefined
          ? { requireClockOutApproval: data.requireClockOutApproval }
          : {}),
        ...(data.requireBreakStartApproval !== undefined
          ? { requireBreakStartApproval: data.requireBreakStartApproval }
          : {}),
        ...(data.requireBreakEndApproval !== undefined
          ? { requireBreakEndApproval: data.requireBreakEndApproval }
          : {}),
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
    requireClockInApproval?: boolean
    requireClockOutApproval?: boolean
    requireBreakStartApproval?: boolean
    requireBreakEndApproval?: boolean
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
        ...(data.requireClockInApproval !== undefined
          ? { requireClockInApproval: data.requireClockInApproval }
          : {}),
        ...(data.requireClockOutApproval !== undefined
          ? { requireClockOutApproval: data.requireClockOutApproval }
          : {}),
        ...(data.requireBreakStartApproval !== undefined
          ? { requireBreakStartApproval: data.requireBreakStartApproval }
          : {}),
        ...(data.requireBreakEndApproval !== undefined
          ? { requireBreakEndApproval: data.requireBreakEndApproval }
          : {}),
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

    const profile = await prisma.employeeProfile.findFirst({
      where: { id: data.employeeProfileId },
      include: {
        user: { select: { id: true, name: true, role: true, organizationId: true } },
      },
    })
    if (!profile || profile.user.organizationId !== data.organizationId) {
      throw new Error("Employee not found in this organization.")
    }

    // Adding to a team implicitly puts the employee in the team's
    // parent project — admins shouldn't have to do "add to project"
    // as a separate step. We upsert both rows in one transaction so a
    // partial failure (project insert succeeds but team membership
    // fails) doesn't leave an orphaned project assignment.
    const upserted = await prisma.$transaction(async (tx) => {
      await tx.employeeProjectAssignment.upsert({
        where: {
          employeeProfileId_projectId: {
            employeeProfileId: profile.id,
            projectId: team.projectId,
          },
        },
        create: {
          employeeProfileId: profile.id,
          projectId: team.projectId,
        },
        update: {}, // already there → no-op
      })
      const membership = await tx.employeeTeamMembership.upsert({
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

      // Keep User.role in sync with the team hierarchy: anyone sitting at layer
      // 2+ in ANY team is a SUPERVISOR; if they're at layer 1 everywhere, they
      // fall back to EMPLOYEE. Only ever toggle EMPLOYEE <-> SUPERVISOR — admins
      // and owners keep their elevated role.
      if (profile.user.role === "EMPLOYEE" || profile.user.role === "SUPERVISOR") {
        const memberships = await tx.employeeTeamMembership.findMany({
          where: { employeeProfileId: profile.id },
          select: { layer: true },
        })
        const desiredRole = memberships.some((m) => m.layer >= 2) ? "SUPERVISOR" : "EMPLOYEE"
        if (desiredRole !== profile.user.role) {
          await tx.user.update({ where: { id: profile.user.id }, data: { role: desiredRole } })
          profile.user.role = desiredRole
        }
      }

      // Auto-fill the (employee, team) approval chain when none exists
      // yet. Without this, adding a member via the Company Structure ›
      // Members table writes the membership row but leaves the chain
      // empty — so claims have nowhere to route, and the employee's
      // Account Info shows "No supervisor assigned" until an admin
      // visits the per-employee Company tab and clicks Save. We only
      // auto-fill when the chain is EMPTY so any manual customization
      // made via the Company tab survives subsequent layer moves.
      //
      // Step numbering follows the same convention as
      // `setEmployeeChainForTeam`: lowest layer above the employee
      // becomes step 1, next becomes step 2, etc. Every SUPERVISOR
      // sitting at a given layer above the employee is added as a
      // parallel approver for that step (any one of them approves to
      // advance).
      if (data.layer < team.layerCount) {
        // Chain for the member being added.
        const existingChain = await tx.approvalChainStep.findFirst({
          where: { employeeId: profile.user.id, teamId: team.id },
          select: { id: true },
        })
        if (!existingChain) {
          const supersAbove = await tx.employeeTeamMembership.findMany({
            where: {
              teamId: team.id,
              layer: { gt: data.layer },
              employeeProfileId: { not: profile.id },
              employeeProfile: { user: { role: "SUPERVISOR" } },
            },
            select: {
              layer: true,
              employeeProfile: { select: { user: { select: { id: true } } } },
            },
          })
          if (supersAbove.length > 0) {
            const layersSorted = [
              ...new Set(supersAbove.map((m) => m.layer)),
            ].sort((a, b) => a - b)
            const layerToStep = new Map<number, number>()
            layersSorted.forEach((layer, idx) =>
              layerToStep.set(layer, idx + 1),
            )
            await tx.approvalChainStep.createMany({
              data: supersAbove.map((m) => ({
                employeeId: profile.user.id,
                teamId: team.id,
                approverId: m.employeeProfile.user.id,
                step: layerToStep.get(m.layer)!,
              })),
            })
          }
        }
      }

      // When the member being added is a SUPERVISOR, also backfill chains
      // for any lower-layer members in this team who have no chain yet.
      // This covers the case where employees are added before their
      // supervisors — without this, those employees are left chainless
      // until an admin manually saves each one via the Company tab.
      if (data.layer >= 2) {
        const unchainedBelow = await tx.employeeTeamMembership.findMany({
          where: {
            teamId: team.id,
            layer: { lt: data.layer },
            employeeProfileId: { not: profile.id },
          },
          select: {
            layer: true,
            employeeProfile: { select: { id: true, user: { select: { id: true } } } },
          },
        })
        for (const below of unchainedBelow) {
          const belowUserId = below.employeeProfile.user.id
          const belowProfileId = below.employeeProfile.id
          const alreadyHasChain = await tx.approvalChainStep.findFirst({
            where: { employeeId: belowUserId, teamId: team.id },
            select: { id: true },
          })
          if (alreadyHasChain) continue
          // Find all supervisors above this lower-layer member (including
          // the one being added now and any already in the team).
          const supersAboveMember = await tx.employeeTeamMembership.findMany({
            where: {
              teamId: team.id,
              layer: { gt: below.layer },
              employeeProfileId: { not: belowProfileId },
              employeeProfile: { user: { role: "SUPERVISOR" } },
            },
            select: {
              layer: true,
              employeeProfile: { select: { user: { select: { id: true } } } },
            },
          })
          if (supersAboveMember.length === 0) continue
          const layersSorted = [
            ...new Set(supersAboveMember.map((m) => m.layer)),
          ].sort((a, b) => a - b)
          const layerToStep = new Map<number, number>()
          layersSorted.forEach((layer, idx) => layerToStep.set(layer, idx + 1))
          await tx.approvalChainStep.createMany({
            data: supersAboveMember.map((m) => ({
              employeeId: belowUserId,
              teamId: team.id,
              approverId: m.employeeProfile.user.id,
              step: layerToStep.get(m.layer)!,
            })),
          })
        }
      }

      return membership
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
      select: {
        id: true,
        employeeProfileId: true,
        teamId: true,
        team: { select: { project: { select: { organizationId: true } } } },
        employeeProfile: { select: { user: { select: { id: true } } } },
      },
    })
    if (
      !membership ||
      membership.team.project.organizationId !== data.organizationId
    ) {
      throw new Error("Membership not found.")
    }

    // Wipe the per-(employee, team) chain rows alongside the membership so
    // we don't leave dangling approval chains pointing at a team the
    // employee no longer belongs to.
    await prisma.$transaction(async (tx) => {
      await tx.approvalChainStep.deleteMany({
        where: {
          teamId: membership.teamId,
          employeeId: membership.employeeProfile.user.id,
        },
      })
      await tx.employeeTeamMembership.delete({ where: { id: membership.id } })

      // Leaving a team can mean they're no longer a layer-2+ supervisor
      // anywhere — re-evaluate role (EMPLOYEE <-> SUPERVISOR only).
      const user = await tx.user.findUnique({
        where: { id: membership.employeeProfile.user.id },
        select: { role: true },
      })
      if (user && (user.role === "EMPLOYEE" || user.role === "SUPERVISOR")) {
        const memberships = await tx.employeeTeamMembership.findMany({
          where: { employeeProfileId: membership.employeeProfileId },
          select: { layer: true },
        })
        const desiredRole = memberships.some((m) => m.layer >= 2) ? "SUPERVISOR" : "EMPLOYEE"
        if (desiredRole !== user.role) {
          await tx.user.update({
            where: { id: membership.employeeProfile.user.id },
            data: { role: desiredRole },
          })
        }
      }
    })
  },

  /**
   * Replace the approval chain for one (employee, team) tuple. Used by
   * `POST /api/v1/teams/[id]/members` to set a member's chain at the
   * same time as assigning them. Mirrors the chain-write logic that
   * lives inside `updateOrganizationMember` but factored out so the
   * external API can call it directly without going through the heavier
   * full-employee-update path.
   *
   * Step numbering is layer-derived (unique layers → unique step
   * numbers), so multiple approvers at the same layer share a step
   * (any-of approval semantics).
   */
  async setTeamMembershipChain(data: {
    organizationId: string
    teamId: string
    /// `userId` of the employee whose chain we're rewriting (NOT the
    /// EmployeeProfile id — chain rows are keyed by User id).
    employeeId: string
    chainApprovers: Array<{ layer: number; userId: string }>
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    // Verify (a) team belongs to this org, (b) employee is a member.
    const team = await prisma.team.findFirst({
      where: { id: data.teamId, project: { organizationId: data.organizationId } },
      select: { id: true, layerCount: true },
    })
    if (!team) throw new Error("Team not found.")

    const member = await prisma.employeeTeamMembership.findFirst({
      where: {
        teamId: team.id,
        employeeProfile: { user: { id: data.employeeId } },
      },
      select: { id: true },
    })
    if (!member) {
      throw new Error("Employee is not a member of this team.")
    }

    // Validate all approvers exist + belong to org + are SUPERVISOR/ADMIN.
    if (data.chainApprovers.length > 0) {
      const ids = Array.from(new Set(data.chainApprovers.map((a) => a.userId)))
      const approvers = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, organizationId: true, role: true },
      })
      if (approvers.length !== ids.length) {
        throw new Error("One or more approvers could not be found.")
      }
      for (const a of approvers) {
        if (a.organizationId !== data.organizationId) {
          throw new Error("Approvers must belong to the same organization.")
        }
        if (a.role !== "SUPERVISOR" && a.role !== "ADMIN" && a.role !== "OWNER") {
          throw new Error("Approvers must be supervisors or admins.")
        }
      }
      for (const a of data.chainApprovers) {
        if (a.layer < 1 || a.layer > team.layerCount) {
          throw new Error(
            `Approver layer ${a.layer} is out of range 1..${team.layerCount}.`,
          )
        }
      }
    }

    // Sort by layer so lower-layer approvers get lower step numbers.
    const sorted = [...data.chainApprovers].sort((a, b) => a.layer - b.layer)
    const layerToStep = new Map<number, number>()
    let stepCounter = 0
    for (const c of sorted) {
      if (!layerToStep.has(c.layer)) {
        stepCounter += 1
        layerToStep.set(c.layer, stepCounter)
      }
    }

    await prisma.$transaction([
      prisma.approvalChainStep.deleteMany({
        where: { employeeId: data.employeeId, teamId: team.id },
      }),
      ...(sorted.length > 0
        ? [
            prisma.approvalChainStep.createMany({
              data: sorted.map((c) => ({
                employeeId: data.employeeId,
                teamId: team.id,
                approverId: c.userId,
                step: layerToStep.get(c.layer)!,
              })),
            }),
          ]
        : []),
    ])
  },

  /**
   * Read back the per-(employee, team) chain for one membership. Used
   * by GET /api/v1/teams/[id]/members so the partner sees the chain
   * alongside the layer.
   */
  async getTeamMembershipChain(data: {
    organizationId: string
    teamId: string
    employeeId: string
  }): Promise<Array<{ step: number; approverId: string; approverName: string }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Org-scope check via the team
    const team = await prisma.team.findFirst({
      where: { id: data.teamId, project: { organizationId: data.organizationId } },
      select: { id: true },
    })
    if (!team) return []

    const rows = await prisma.approvalChainStep.findMany({
      where: { teamId: team.id, employeeId: data.employeeId },
      orderBy: { step: "asc" },
      include: { approver: { select: { id: true, name: true } } },
    })
    return rows.map((r) => ({
      step: r.step,
      approverId: r.approver.id,
      approverName: r.approver.name,
    }))
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
            employeeProfiles: {
              some: {
                projectAssignments: {
                  some: { projectId: project.id },
                },
              },
            },
          },
          {
            employeeProfiles: {
              some: { project: project.name },
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        employeeProfiles: {
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
      const membership = s.employeeProfiles[0]?.teamMemberships?.[0]
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
  requireClockInApproval: boolean
  requireClockOutApproval: boolean
  requireBreakStartApproval: boolean
  requireBreakEndApproval: boolean
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
    requireClockInApproval: row.requireClockInApproval,
    requireClockOutApproval: row.requireClockOutApproval,
    requireBreakStartApproval: row.requireBreakStartApproval,
    requireBreakEndApproval: row.requireBreakEndApproval,
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
