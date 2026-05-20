export const LEAVE_ACCRUAL_METHODS = ["LUMP_SUM", "PRO_RATED"] as const
export type LeaveAccrualMethod = (typeof LEAVE_ACCRUAL_METHODS)[number]

export const LEAVE_DURATIONS = ["FULL_DAY", "MORNING", "AFTERNOON"] as const
export type LeaveDuration = (typeof LEAVE_DURATIONS)[number]

export const LEAVE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const
export type LeaveStatus = (typeof LEAVE_STATUSES)[number]

export type LeaveTypeView = {
  id: string
  code: string
  name: string
  paid: boolean
  accrualMethod: LeaveAccrualMethod
  defaultDays: number
  carryForward: boolean
  carryExpiryMonth: number | null
  maxCarryForwardDays: number | null
  archivedAt: Date | null
}

export type PolicyLeaveDefault = {
  policyId: string
  leaveTypeId: string
  defaultDays: number
}

export type LeaveEntitlementView = {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveTypeCode: string
  leaveTypeName: string
  paid: boolean
  accrualMethod: LeaveAccrualMethod
  year: number
  entitledDays: number
  carriedDays: number
  carriedExpiresAt: Date | null
  carriedExpired: boolean
  accruedDays: number
  usedDays: number
  /// Computed: days the employee can apply for right now.
  availableDays: number
}

export type LeaveApprovalEntry = {
  step: number
  approverId: string
  decision: "APPROVED" | "REJECTED"
  decidedAt: string
  notes?: string
}

export type LeaveApplicationView = {
  id: string
  employeeId: string
  employeeName: string
  leaveTypeId: string
  leaveTypeCode: string
  leaveTypeName: string
  paid: boolean
  startDate: Date
  endDate: Date
  duration: LeaveDuration
  totalDays: number
  reason: string | null
  status: LeaveStatus
  currentStep: number
  approvals: LeaveApprovalEntry[]
  createdAt: Date
  decidedAt: Date | null
}

export function isAnnualCode(code: string): boolean {
  return code.toUpperCase() === "ANNUAL"
}
