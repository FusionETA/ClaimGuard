import "server-only"

import {
  availableDaysFor,
  initialProRatedAccrual,
} from "@/modules/leave/domain/accrual"
import type {
  LeaveAccrualMethod,
  LeaveEntitlementView,
} from "@/modules/leave/domain/models"
import {
  getLeavePrismaClient,
  getLeavePrismaClientSafe,
  leaveRepository,
} from "@/modules/leave/infrastructure/leave-repository"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"

/// Resolve the default entitlement days for an employee × leave type.
/// Resolution order:
///   1. Per-employee LeaveEntitlement override (handled by the caller; this
///      helper returns the *would-be* default, not the override).
///   2. PolicyLeaveEntitlement (if a row exists for the employee's policy).
///   3. LeaveType.defaultDays.
export async function resolveDefaultEntitledDays(
  employeeId: string,
  leaveTypeId: string,
): Promise<number> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return 0
  const [type, employee] = await Promise.all([
    prisma.leaveType.findUnique({ where: { id: leaveTypeId } }),
    prisma.employeeProfile.findUnique({
      where: { id: employeeId },
      select: { policyId: true },
    }),
  ])
  if (!type) return 0
  if (employee?.policyId) {
    const override = await prisma.policyLeaveEntitlement.findUnique({
      where: {
        policyId_leaveTypeId: { policyId: employee.policyId, leaveTypeId },
      },
    })
    if (override) return override.defaultDays
  }
  return type.defaultDays
}

/// Resolve the effective `accrualMethod` for an employee × leave type by
/// walking the 3-layer chain:
///   1. `LeaveEntitlement.accrualMethod` for the requested year — if
///      non-null, return it.
///   2. `PolicyLeaveEntitlement.accrualMethod` for the employee's policy
///      — if non-null, return it.
///   3. `LeaveType.accrualMethod` (always non-null).
///
/// Mirrors `resolveDefaultEntitledDays` above but for the method. Used
/// by every consumer that previously read `LeaveType.accrualMethod`
/// directly (the monthly cron, year rollover, balance view-mapper).
export async function resolveAccrualMethod(
  employeeId: string,
  leaveTypeId: string,
  year: number = currentYearMYT(),
): Promise<LeaveAccrualMethod> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return "LUMP_SUM"

  const [entitlement, type, employee] = await Promise.all([
    prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
      },
      select: { accrualMethod: true },
    }),
    prisma.leaveType.findUnique({
      where: { id: leaveTypeId },
      select: { accrualMethod: true },
    }),
    prisma.employeeProfile.findUnique({
      where: { id: employeeId },
      select: { policyId: true },
    }),
  ])

  if (entitlement?.accrualMethod) {
    return entitlement.accrualMethod as LeaveAccrualMethod
  }
  if (employee?.policyId) {
    const policyOverride = await prisma.policyLeaveEntitlement.findUnique({
      where: {
        policyId_leaveTypeId: { policyId: employee.policyId, leaveTypeId },
      },
      select: { accrualMethod: true },
    })
    if (policyOverride?.accrualMethod) {
      return policyOverride.accrualMethod as LeaveAccrualMethod
    }
  }
  return (type?.accrualMethod ?? "LUMP_SUM") as LeaveAccrualMethod
}

/// Same as `resolveAccrualMethod` but operates on already-loaded layer
/// values. Use this when batch-resolving many (employee, type) pairs to
/// avoid N+1 queries.
export function resolveAccrualMethodFromLayers(layers: {
  employeeMethod: LeaveAccrualMethod | null
  policyMethod: LeaveAccrualMethod | null
  typeMethod: LeaveAccrualMethod
}): LeaveAccrualMethod {
  return layers.employeeMethod ?? layers.policyMethod ?? layers.typeMethod
}

/// The current year in Asia/Kuala_Lumpur, used as the default year for
/// resolver lookups. Matches the cron's timezone choice so a Jan 1
/// firing crosses the year boundary at MYT midnight, not UTC midnight.
function currentYearMYT(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
    }).format(now),
  )
}

/// Ensure a LeaveEntitlement row exists for (employee, leaveType, year),
/// creating one with the resolved default if missing. Returns the row.
///
/// Race-safe: concurrent calls (e.g. parallel page loads invoking
/// listEmployeeBalances) can both miss the read, then both try to INSERT.
/// We catch the P2002 unique-constraint error and re-fetch — the other
/// caller already inserted the row, so the fetch succeeds.
export async function ensureEntitlement(
  employeeId: string,
  leaveTypeId: string,
  year: number,
) {
  const existing = await leaveRepository.getEntitlement(employeeId, leaveTypeId, year)
  if (existing) return existing
  const prisma = getLeavePrismaClient()
  const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
  if (!type) throw new Error("Leave type not found")
  const entitledDays = await resolveDefaultEntitledDays(employeeId, leaveTypeId)
  // Resolve the effective accrual method. No `LeaveEntitlement` row
  // exists at this point by definition, so the employee layer is
  // skipped — we walk policy → type. The created row carries
  // `accrualMethod = null` (inherit) so any future change at the
  // policy/type layer is picked up automatically.
  const effectiveMethod = await resolveAccrualMethod(employeeId, leaveTypeId, year)
  // For LUMP_SUM, accrued mirrors entitled (full availability immediately).
  // For PRO_RATED, seed with a join-date-aware backfill so an
  // employee who joined mid-year (or whose row is being created
  // lazily after several months have already elapsed) starts with
  // the accrual they *should* have had on day one. Without this,
  // the cron only adds 1/12 going forward and the employee silently
  // loses every accrual that fired before their row existed.
  let accruedDays: number
  if (effectiveMethod === "PRO_RATED") {
    const joinDate = await leaveRepository.getEmployeeJoinDate(employeeId)
    accruedDays = initialProRatedAccrual({
      entitledDays,
      joinDate,
      targetYear: year,
      now: new Date(),
    })
  } else {
    accruedDays = entitledDays
  }
  try {
    return await leaveRepository.upsertEntitlement({
      employeeId,
      leaveTypeId,
      year,
      entitledDays,
      accruedDays,
      carriedDays: 0,
      carriedExpiresAt: null,
    })
  } catch (err) {
    // Someone else won the race — re-read and return their row.
    if (isUniqueConstraintError(err)) {
      const row = await leaveRepository.getEntitlement(employeeId, leaveTypeId, year)
      if (row) return row
    }
    throw err
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const code = (err as { code?: string }).code
  return code === "P2002"
}

/// Same as `listEmployeeBalances` but accepts a `User.id` and handles
/// the userId → employeeProfileId lookup internally. Pages and routes
/// should call this version so they don't have to touch Prisma directly
/// just to map the session userId.
export async function listEmployeeBalancesForUser(
  userId: string,
  year: number,
): Promise<LeaveEntitlementView[]> {
  const profileId = await leaveRepository.findEmployeeProfileIdByUserId(userId)
  if (!profileId) return []
  return listEmployeeBalances(profileId, year)
}

/// List a single employee's balances for the current year, including
/// computed `availableDays` per entitlement.
export async function listEmployeeBalances(
  employeeId: string,
  year: number,
): Promise<LeaveEntitlementView[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  // Ensure rows exist for every non-archived leave type before reading.
  const types = await prisma.leaveType.findMany({
    where: {
      archivedAt: null,
      organization: { users: { some: { employeeProfile: { id: employeeId } } } },
    },
    select: { id: true },
  })
  for (const t of types) {
    await ensureEntitlement(employeeId, t.id, year)
  }

  const rows = await leaveRepository.listEntitlementsForEmployee(employeeId, year)
  return rows.map((r) => ({
    ...r,
    availableDays: availableDaysFor({
      accrualMethod: r.accrualMethod,
      entitledDays: r.entitledDays,
      accruedDays: r.accruedDays,
      carriedDays: r.carriedDays,
      carriedExpired: r.carriedExpired,
      usedDays: r.usedDays,
    }),
  }))
}

/// Admin override of a single employee's entitlement for the year.
/// `entitledDays` is required; `accrualMethod` is optional — pass null
/// to clear the override (resolver walks up to policy/type), pass a
/// value to set the override, or omit (`undefined`) to leave the
/// existing per-employee override untouched.
export async function setEmployeeEntitlement(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  entitledDays: number,
  accrualMethod?: LeaveAccrualMethod | null,
) {
  if (entitledDays < 0) throw new Error("Entitled days cannot be negative")
  const existing = await ensureEntitlement(employeeId, leaveTypeId, year)

  // Resolve the effective method AFTER any update we're about to make,
  // so the accrued-days recompute matches what consumers will see going
  // forward. If the caller passed an explicit method, use that;
  // otherwise re-resolve via the chain.
  const effectiveMethod =
    accrualMethod !== undefined && accrualMethod !== null
      ? accrualMethod
      : await resolveAccrualMethod(employeeId, leaveTypeId, year)

  // For LUMP_SUM the accrued mirrors entitled; for PRO_RATED accrued is
  // capped at the new entitled (don't go above the new ceiling).
  const accruedDays =
    effectiveMethod === "PRO_RATED"
      ? Math.min(existing.accruedDays, entitledDays)
      : entitledDays

  return leaveRepository.upsertEntitlement({
    employeeId,
    leaveTypeId,
    year,
    entitledDays,
    accruedDays,
    accrualMethod,
  })
}

/// Reset an employee's entitlement back to the resolved default
/// (policy override → leave type default). Clears BOTH `entitledDays`
/// override and `accrualMethod` override so the row inherits from the
/// next layer up for every field.
export async function resetEmployeeEntitlementToDefault(
  employeeId: string,
  leaveTypeId: string,
  year: number,
) {
  const days = await resolveDefaultEntitledDays(employeeId, leaveTypeId)
  return setEmployeeEntitlement(employeeId, leaveTypeId, year, days, null)
}

/// Per-employee balance bundle used by the admin and supervisor list
/// views. Carries enough identity info to render a row label without an
/// extra round-trip.
export type EmployeeLeaveBalances = {
  userId: string
  employeeProfileId: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN" | "OWNER"
  jobTitle: string
  balances: LeaveEntitlementView[]
}

/// All employees in an org with their leave balances for the given year.
/// Admin view (`/admin/leave/balances`) consumes this. Iterates the
/// per-employee balance fetcher so each row gets the same
/// `ensureEntitlement` + availableDays computation it would as a single
/// fetch — guaranteeing rows exist for every active leave type and
/// avoiding "missing entitlement" gaps after the year rollover.
export async function listAllEmployeeBalancesForOrg(
  organizationId: string,
  year: number,
): Promise<EmployeeLeaveBalances[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  const employees = await prisma.employeeProfile.findMany({
    where: {
      user: { organizationId, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
    },
    select: {
      id: true,
      jobTitle: true,
      user: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: { user: { name: "asc" } },
  })

  return Promise.all(
    employees.map(async (e) => ({
      userId: e.user.id,
      employeeProfileId: e.id,
      name: e.user.name,
      email: e.user.email,
      role: e.user.role as EmployeeLeaveBalances["role"],
      jobTitle: e.jobTitle,
      balances: await listEmployeeBalances(e.id, year),
    })),
  )
}

/// Direct-reports view for supervisors. Returns balances only for the
/// employees the supervisor is in the approval chain for (any module),
/// reusing the existing `attendanceRepository.getTeamMemberIds()` lookup
/// so "who reports to me" stays in one place. Returns [] when the
/// supervisor has no direct reports configured.
export async function listTeamBalancesForSupervisor(
  supervisorUserId: string,
  year: number,
): Promise<EmployeeLeaveBalances[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  const memberIds = await attendanceRepository.getTeamMemberIds(supervisorUserId)
  if (memberIds.length === 0) return []

  const employees = await prisma.employeeProfile.findMany({
    where: { userId: { in: memberIds } },
    select: {
      id: true,
      jobTitle: true,
      user: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: { user: { name: "asc" } },
  })

  return Promise.all(
    employees.map(async (e) => ({
      userId: e.user.id,
      employeeProfileId: e.id,
      name: e.user.name,
      email: e.user.email,
      role: e.user.role as EmployeeLeaveBalances["role"],
      jobTitle: e.jobTitle,
      balances: await listEmployeeBalances(e.id, year),
    })),
  )
}
