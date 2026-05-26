import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { bustOrgConfigCaches, bustPayrollCaches } from "@/lib/cache-invalidation"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import type {
  PayrollEmployeeRow,
  PayrollProfileData,
} from "@/modules/payroll/domain/models"
import type { SalaryChangeData } from "@/modules/payroll/domain/salary-change"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import { salaryChangeRepository } from "@/modules/payroll/infrastructure/salary-change.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import type { EmployeePolicy } from "@/modules/policy/domain/models"

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
export async function getManageEmployeesPageData(): Promise<{
  organizationName: string
  employees: PayrollEmployeeRow[]
  policies: EmployeePolicy[]
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 10-min TTL under the org "config" namespace. Busted by
  // `bustOrgConfigCaches` on hierarchy/member edits AND — because the
  // list shows payroll-readiness — by the payroll-profile save/archive
  // actions (which now also call bustOrgConfigCaches).
  return getOrSetCache(
    key("org", orgId, "config", "page", "manage-employees"),
    600,
    () => loadManageEmployeesPageData(orgId),
  )
}

async function loadManageEmployeesPageData(orgId: string): Promise<{
  organizationName: string
  employees: PayrollEmployeeRow[]
  policies: EmployeePolicy[]
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, employees, policies] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollProfileRepository.listForOrganization(orgId),
    policyRepository.listForOrganization(orgId),
  ])

  return {
    organizationName: org?.name ?? "",
    employees,
    policies,
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
      employeeProfile: {
        select: { id: true, employeeId: true, jobTitle: true },
      },
    },
  })
  if (!user || !user.employeeProfile) return null

  const [profile, settings, salaryHistory] = await Promise.all([
    payrollProfileRepository.getByEmployeeProfileId(user.employeeProfile.id),
    payrollSettingsRepository.getByOrgId(orgId),
    salaryChangeRepository.listForEmployee(user.employeeProfile.id),
  ])

  return {
    userId: user.id,
    employeeProfileId: user.employeeProfile.id,
    employeeId: user.employeeProfile.employeeId,
    name: user.name,
    email: user.email,
    jobTitle: user.employeeProfile.jobTitle,
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
    select: { employeeProfile: { select: { id: true } } },
  })
  if (!user?.employeeProfile) {
    throw new Error("Employee not found in this organisation.")
  }

  const result = await payrollProfileRepository.upsert({
    employeeProfileId: user.employeeProfile.id,
    patch: input.patch,
  })

  // Readiness (isComplete) shown on the Manage Employee list lives under
  // the org config namespace; eligible-employee counts live under
  // payroll. Bust both so neither shows stale state after an edit.
  await bustOrgConfigCaches({ organizationId: orgId })
  await bustPayrollCaches({ organizationId: orgId })

  return result
}

/**
 * Archive a payroll profile (employee leaves the company / no longer
 * on payroll). Historical payslips are retained.
 */
export async function archivePayrollProfile(input: {
  userId: string
  reason: string
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
    select: { employeeProfile: { select: { id: true } } },
  })
  if (!user?.employeeProfile) {
    throw new Error("Employee not found in this organisation.")
  }

  await payrollProfileRepository.archive(user.employeeProfile.id, input.reason)
  await bustOrgConfigCaches({ organizationId: orgId })
  await bustPayrollCaches({ organizationId: orgId })
}

export async function unarchivePayrollProfile(input: {
  userId: string
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
    select: { employeeProfile: { select: { id: true } } },
  })
  if (!user?.employeeProfile) {
    throw new Error("Employee not found in this organisation.")
  }

  await payrollProfileRepository.unarchive(user.employeeProfile.id)
  await bustOrgConfigCaches({ organizationId: orgId })
  await bustPayrollCaches({ organizationId: orgId })
}
