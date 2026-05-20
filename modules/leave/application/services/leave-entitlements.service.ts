import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { availableDaysFor } from "@/modules/leave/domain/accrual"
import type { LeaveEntitlementView } from "@/modules/leave/domain/models"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

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
  const prisma = getPrismaClient()
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
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Prisma not configured")
  const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
  if (!type) throw new Error("Leave type not found")
  const entitledDays = await resolveDefaultEntitledDays(employeeId, leaveTypeId)
  // For LUMP_SUM, accrued mirrors entitled (full availability immediately).
  // For PRO_RATED, accrued starts at 0 — the monthly job increments it.
  const accruedDays = type.accrualMethod === "PRO_RATED" ? 0 : entitledDays
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

/// List a single employee's balances for the current year, including
/// computed `availableDays` per entitlement.
export async function listEmployeeBalances(
  employeeId: string,
  year: number,
): Promise<LeaveEntitlementView[]> {
  const prisma = getPrismaClient()
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

/// Admin override of a single employee's annual entitlement for the year.
export async function setEmployeeEntitlement(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  entitledDays: number,
) {
  if (entitledDays < 0) throw new Error("Entitled days cannot be negative")
  const existing = await ensureEntitlement(employeeId, leaveTypeId, year)
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Prisma not configured")
  const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
  if (!type) throw new Error("Leave type not found")

  // For LUMP_SUM the accrued mirrors entitled; for PRO_RATED accrued is
  // capped at the new entitled (don't go above the new ceiling).
  const accruedDays =
    type.accrualMethod === "PRO_RATED"
      ? Math.min(existing.accruedDays, entitledDays)
      : entitledDays

  return leaveRepository.upsertEntitlement({
    employeeId,
    leaveTypeId,
    year,
    entitledDays,
    accruedDays,
  })
}

/// Reset an employee's entitlement back to the resolved default
/// (policy override → leave type default).
export async function resetEmployeeEntitlementToDefault(
  employeeId: string,
  leaveTypeId: string,
  year: number,
) {
  const days = await resolveDefaultEntitledDays(employeeId, leaveTypeId)
  return setEmployeeEntitlement(employeeId, leaveTypeId, year, days)
}
