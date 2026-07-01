import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { bustOrgConfigCaches, bustPayrollCaches } from "@/lib/cache-invalidation"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
import {
  getPayrollPrismaClientSafe as getPrismaClient,
  payrollRunRepository,
} from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import type {
  PayrollEmployeeRow,
  PayrollProfileData,
} from "@/modules/payroll/domain/models"
import type { SalaryChangeData } from "@/modules/payroll/domain/salary-change"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import { salaryChangeRepository } from "@/modules/payroll/infrastructure/salary-change.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import type { EmployeePolicy } from "@/modules/policy/domain/models"
import type { LeaveTypeView } from "@/modules/leave/domain/models"
import { listLeaveTypes } from "@/modules/leave/application/services/leave-types.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { recomputeProRatedAccrualForEmployee } from "@/modules/leave/application/services/leave-entitlements.service"

/**
 * Page-data + action services for the admin payroll module.
 *
 * Every method here:
 *   1. Validates the current session is an admin.
 *   2. Verifies the target employee belongs to the admin's active
 *      organisation — prevents an admin from one org from poking at
 *      another org's employees.
 *   3. Delegates to the repo for the actual mutation/read.
 *
 * Returns null when the session is missing/invalid; pages should call
 * redirect() in that case.
 */

/**
 * Page-data for the unified "Company/Employee → Manage Employee" list
 * (route /admin/hierarchy). Same employee rows as the payroll list,
 * plus the active employee policies needed by the inline "Add
 * employee" dialog (which creates a bare member; projects / teams /
 * approval-chain are then filled in via the detail editor's Company
 * tab).
 */
/// View-model row passed into the Add Employee dialog so it can render
/// the per-type Leave Method inputs without an extra round-trip.
export type AddEmployeeLeaveType = {
  id: string
  code: string
  name: string
  paid: boolean
  /// Resolved by the policy → type chain. The Add Employee dialog
  /// shows the policy-layer override if one exists for the policy
  /// the admin picks; otherwise this is the type default.
  defaultDays: number
  /// Same idea for accrualMethod.
  accrualMethod: "LUMP_SUM" | "PRO_RATED"
}

export async function getManageEmployeesPageData(): Promise<{
  organizationName: string
  employees: PayrollEmployeeRow[]
  policies: EmployeePolicy[]
  /// Non-archived leave types in this org. Drives the Add Employee
  /// dialog's Custom-mode per-type inputs and the empty-state guard
  /// ("Set up Settings → Leave first" when this is empty).
  leaveTypes: AddEmployeeLeaveType[]
  /// Per-policy overrides — the dialog uses these to pre-fill the
  /// Custom-mode inputs with the right inherited values for the
  /// selected policy.
  policyDefaults: Array<{
    policyId: string
    leaveTypeId: string
    defaultDays: number
    accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
  }>
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // Per-admin policy scope tag in the cache key — two admins with
  // different grants shouldn't share an entry. `null` (owner / legacy)
  // collapses to the existing `_all` segment so already-cached entries
  // remain hot.
  const policyIdScope = await getActiveAdminPolicyScope()
  const scopeTag =
    policyIdScope === null ? "_all" : `p:${[...policyIdScope].sort().join(",")}`

  // 10-min TTL under the org "config" namespace. Busted by
  // `bustOrgConfigCaches` on hierarchy/member edits AND — because the
  // list shows payroll-readiness — by the payroll-profile save/archive
  // actions (which now also call bustOrgConfigCaches).
  return getOrSetCache(
    key("org", orgId, "config", "page", "manage-employees", scopeTag),
    600,
    () => loadManageEmployeesPageData(orgId),
  )
}

async function loadManageEmployeesPageData(orgId: string): Promise<{
  organizationName: string
  employees: PayrollEmployeeRow[]
  policies: EmployeePolicy[]
  leaveTypes: AddEmployeeLeaveType[]
  policyDefaults: Array<{
    policyId: string
    leaveTypeId: string
    defaultDays: number
    accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
  }>
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  // Restrict the employee list to the admin's granted policies.
  const policyIdScope = await getActiveAdminPolicyScope()

  const [org, employees, policies, leaveTypesRaw, policyDefaults] =
    await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      }),
      payrollProfileRepository.listForOrganization(orgId, { policyIdScope }),
      policyRepository.listForOrganization(orgId),
      listLeaveTypes(orgId, false),
      leaveRepository.listPolicyDefaults(orgId),
    ])

  // Strip the leave-type rows down to what the dialog actually needs
  // — keeps the cached payload small and decouples the view from
  // future leave-type column additions.
  const leaveTypes: AddEmployeeLeaveType[] = (leaveTypesRaw as LeaveTypeView[])
    .filter((t) => !t.archivedAt)
    .map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      paid: t.paid,
      defaultDays: t.defaultDays,
      accrualMethod: t.accrualMethod,
    }))

  return {
    organizationName: org?.name ?? "",
    employees,
    policies,
    leaveTypes,
    policyDefaults,
  }
}

/**
 * Page-data for "Payroll → Employees → [userId]" detail page.
 *
 * Returns:
 *   - basic identity from User + EmployeeProfile (so the form can show
 *     "Personal" tab fields like name/email even when no PayrollProfile
 *     exists yet)
 *   - the PayrollProfile if it exists, or null (UI shows empty form)
 *
 * Returns `notFound` when the userId doesn't belong to this admin's
 * organisation — caller redirects to the list.
 */
export async function getPayrollEmployeeDetailPageData(input: {
  userId: string
}): Promise<
  | {
      userId: string
      employeeProfileId: string
      employeeId: string
      name: string
      email: string
      jobTitle: string
      profile: PayrollProfileData | null
      defaultEpfEmployerRate: number
      salaryHistory: SalaryChangeData[]
    }
  | null
> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  // Scope to this admin's active org — prevents cross-org access via
  // an arbitrary userId in the URL.
  const user = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: {
      id: true,
      email: true,
      name: true,
      employeeProfiles: {
        where: { organizationId: orgId },
        select: { id: true, employeeId: true, jobTitle: true },
        take: 1,
      },
    },
  })
  const detailProfile = user?.employeeProfiles[0] ?? null
  if (!user || !detailProfile) return null

  const [profile, settings, salaryHistory] = await Promise.all([
    payrollProfileRepository.getByEmployeeProfileId(detailProfile.id),
    payrollSettingsRepository.getByOrgId(orgId),
    salaryChangeRepository.listForEmployee(detailProfile.id),
  ])

  return {
    userId: user.id,
    employeeProfileId: detailProfile.id,
    employeeId: detailProfile.employeeId,
    name: user.name,
    email: user.email,
    jobTitle: detailProfile.jobTitle,
    profile,
    defaultEpfEmployerRate: settings?.defaultEpfEmployerRate ?? 13,
    salaryHistory,
  }
}

/**
 * Upsert handler used by every tab's form action. Validates the target
 * employee belongs to the admin's org before delegating to the repo.
 *
 * Throws on auth failure; the action layer turns that into a form
 * error state.
 */
export async function upsertPayrollProfile(input: {
  userId: string
  patch: Parameters<typeof payrollProfileRepository.upsert>[0]["patch"]
}): Promise<PayrollProfileData> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const user = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: {
      employeeProfiles: {
        where: { organizationId: orgId },
        select: {
          id: true,
          payrollProfile: { select: { joinDate: true } },
        },
        take: 1,
      },
    },
  })
  const upsertProfile = user?.employeeProfiles[0] ?? null
  if (!upsertProfile) {
    throw new Error("Employee not found in this organisation.")
  }

  // Snapshot the previous joinDate so we can detect changes after
  // the upsert and trigger the PRO_RATED accrual recompute. Compared
  // as ISO date strings to avoid Date-instance equality issues.
  const previousJoinDate = upsertProfile.payrollProfile?.joinDate ?? null

  const result = await payrollProfileRepository.upsert({
    employeeProfileId: upsertProfile.id,
    patch: input.patch,
  })

  // If joinDate changed (set for the first time, or updated to a
  // different date), recompute PRO_RATED accrued days for every
  // entitlement row that's safe to touch (no per-employee override,
  // no leave used yet). This closes the "I set joinDate after
  // hiring and the balance didn't move" gap.
  const nextJoinDate = await leaveRepository.getEmployeeJoinDate(
    upsertProfile.id,
  )
  if (!sameDate(previousJoinDate, nextJoinDate)) {
    await recomputeProRatedAccrualForEmployee(upsertProfile.id)
  }

  // Readiness (isComplete) shown on the Manage Employee list lives under
  // the org config namespace; eligible-employee counts live under
  // payroll. Bust both so neither shows stale state after an edit.
  await bustOrgConfigCaches({ organizationId: orgId })
  await bustPayrollCaches({ organizationId: orgId })

  // Mark every DRAFT run in the org as stale. A PayrollProfile save
  // can touch any of ~30 calc-affecting fields (SOCSO scheme, EPF
  // rate, PCB-borne, DOB, citizenship, relief flags, etc.) and we
  // don't diff per-field — the cost of a false positive is one extra
  // "Generate" click; the cost of a false negative is wrong PCB /
  // SOCSO numbers shipping. Mark broadly, regenerate cheaply.
  await payrollRunRepository.markDraftsStaleForOrg(orgId)

  return result
}

/// Compare two nullable dates for equality at day-precision (avoids
/// false positives from time-zone shifts when the column was reread
/// via a different code path).
function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
}

/**
 * Archive a payroll profile (employee leaves the company / no longer
 * on payroll). Historical payslips are retained.
 */
export async function archivePayrollProfile(input: {
  userId: string
  reason: string
  /**
   * Last day the employee is on payroll. The calc engine reads this
   * to prorate the final pay run — e.g. leaveDate = 2026-05-20 means
   * the May payslip is computed across 1–20 May only, and the
   * employee is excluded from June+ runs.
   */
  leaveDate: Date
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const user = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: {
      employeeProfiles: {
        where: { organizationId: orgId },
        select: { id: true },
        take: 1,
      },
    },
  })
  const archiveProfile = user?.employeeProfiles[0]
  if (!archiveProfile) {
    throw new Error("Employee not found in this organisation.")
  }

  await payrollProfileRepository.archive(
    archiveProfile.id,
    input.reason,
    input.leaveDate,
  )

  void writeAudit({
    organizationId: orgId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "employee.archive",
    status: "SUCCESS",
    summary: `Archived employee (last working day ${input.leaveDate.toISOString().slice(0, 10)})${input.reason ? ` — ${input.reason}` : ""}`,
    targetType: "user",
    targetId: input.userId,
    metadata: {
      leaveDate: input.leaveDate.toISOString().slice(0, 10),
      reason: input.reason,
    },
  })

  await bustOrgConfigCaches({ organizationId: orgId })
  await bustPayrollCaches({ organizationId: orgId })
}

/// Update the employee's primary (login) email. Validates that the new
/// address is well-formed and unique across users — Prisma's unique
/// constraint on `User.email` raises P2002 on collision, which we map
/// to a friendly "Already in use" message so the form action can surface
/// it as a toast. Same admin/org guard as the other helpers in this file.
/// Returns `{ changed }` so the caller (the personal-tab action) can
/// decide whether to revalidate aggressively.
export async function updateEmployeeEmail(input: {
  userId: string
  newEmail: string
}): Promise<{ changed: boolean }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  // Normalise: strip whitespace + lower-case the local-part-and-domain
  // so duplicate detection isn't case-sensitive. Login uses
  // findUnique({ email }) so the stored value must match what the user
  // will type — lower-case both sides.
  const next = input.newEmail.trim().toLowerCase()
  // Cheap RFC-5322-ish sanity check — the real validation already ran
  // in the action's zod schema. This is a defensive backstop.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
    throw new Error("Email format looks invalid.")
  }

  const target = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: { id: true, email: true },
  })
  if (!target) {
    throw new Error("Employee not found in this organisation.")
  }
  if (target.email.toLowerCase() === next) {
    return { changed: false }
  }

  try {
    await prisma.user.update({
      where: { id: target.id },
      data: { email: next },
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === "P2002") {
      throw new Error("That email is already used by another user.")
    }
    throw err
  }

  await bustOrgConfigCaches({ organizationId: orgId })
  return { changed: true }
}

export async function unarchivePayrollProfile(input: {
  userId: string
  /// When set, admin indicated the employee worked elsewhere during
  /// the absence and entered the TOTAL YTD figures. The repo persists
  /// these + sets `prevIncludesPriorThisOrgPeriod = true` so the
  /// payroll-run engine subtracts this org's existing YTD before
  /// adding to PCB — preventing double-count.
  rehireCarryover?: {
    prevEmploymentYear: number
    prevRemuneration: number
    prevEpf: number
    prevPcb: number
    prevZakat: number
  } | null
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const user = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: {
      employeeProfiles: {
        where: { organizationId: orgId },
        select: { id: true },
        take: 1,
      },
    },
  })
  const restoreProfile = user?.employeeProfiles[0]
  if (!restoreProfile) {
    throw new Error("Employee not found in this organisation.")
  }

  await payrollProfileRepository.unarchive(
    restoreProfile.id,
    input.rehireCarryover ?? null,
  )

  void writeAudit({
    organizationId: orgId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "employee.restore",
    status: "SUCCESS",
    summary: input.rehireCarryover
      ? "Restored employee to active payroll (with rehire TP3 carryover)"
      : "Restored employee to active payroll",
    targetType: "user",
    targetId: input.userId,
  })

  await bustOrgConfigCaches({ organizationId: orgId })
  await bustPayrollCaches({ organizationId: orgId })
}
