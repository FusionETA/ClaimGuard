import "server-only"

import { getLeavePrismaClientSafe } from "@/modules/leave/infrastructure/leave-repository"
import type { LeaveAccrualMethod } from "@/modules/leave/domain/models"

/// The canonical built-in leave types every org should have. Created
/// lazily on first admin visit to /admin/leave/settings via
/// `ensureDefaultLeaveTypesForOrg`. All are editable and archivable
/// except UNPAID — see `isProtectedLeaveType`.
export const DEFAULT_LEAVE_TYPES: Array<{
  code: string
  name: string
  paid: boolean
  accrualMethod: LeaveAccrualMethod
  defaultDays: number
  carryForward: boolean
  carryExpiryMonth: number | null
  maxCarryForwardDays: number | null
}> = [
  {
    code: "ANNUAL",
    name: "Annual Leave",
    paid: true,
    accrualMethod: "LUMP_SUM",
    defaultDays: 14,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
  {
    code: "MEDICAL",
    name: "Medical Leave",
    paid: true,
    accrualMethod: "LUMP_SUM",
    defaultDays: 14,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
  {
    code: "COMPASSIONATE",
    name: "Compassionate Leave",
    paid: true,
    accrualMethod: "LUMP_SUM",
    defaultDays: 3,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
  {
    code: "HOSPITALIZATION",
    name: "Hospitalization Leave",
    paid: true,
    accrualMethod: "LUMP_SUM",
    defaultDays: 60,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
  {
    code: "MARRIAGE",
    name: "Marriage Leave",
    paid: true,
    accrualMethod: "LUMP_SUM",
    defaultDays: 3,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
  {
    code: "PATERNITY",
    name: "Paternity Leave",
    paid: true,
    accrualMethod: "LUMP_SUM",
    defaultDays: 7,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
  {
    code: "UNPAID",
    name: "Unpaid Leave",
    paid: false,
    accrualMethod: "LUMP_SUM",
    defaultDays: 0,
    carryForward: false,
    carryExpiryMonth: null,
    maxCarryForwardDays: null,
  },
]

/// Leave types whose `code` cannot be edited or archived from the admin UI.
/// Today: UNPAID is locked because every org always needs an unpaid option.
export function isProtectedLeaveType(code: string): boolean {
  return code.toUpperCase() === "UNPAID"
}

/// Idempotently create any missing default leave types for an org.
/// Existing rows (matched by orgId + code) are left untouched — the admin
/// may have customised defaultDays or other fields, and we never overwrite
/// admin edits.
export async function ensureDefaultLeaveTypesForOrg(orgId: string): Promise<void> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return
  const existing = await prisma.leaveType.findMany({
    where: { organizationId: orgId },
    select: { code: true },
  })
  const existingCodes = new Set(existing.map((r) => r.code.toUpperCase()))
  const missing = DEFAULT_LEAVE_TYPES.filter((d) => !existingCodes.has(d.code))
  if (missing.length === 0) return
  await prisma.leaveType.createMany({
    data: missing.map((d) => ({ organizationId: orgId, ...d })),
    skipDuplicates: true,
  })
}
