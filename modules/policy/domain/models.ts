import type {
  EmployeePayoutMethod,
  OtPayoutMethod,
  OtRates,
} from "@/modules/organization/domain/models"

/// Admin-configurable classification for an employee. Replaces the previous
/// hardcoded "Hourly Worker" / "Office Worker" pair. The policy is the
/// admin-facing source of truth for salary type and OT behavior.
export type EmployeePolicy = {
  id: string
  organizationId: string
  name: string
  description?: string
  isDefault: boolean
  archived: boolean
  canAccessAttendance: boolean
  canAccessClaims: boolean
  canAccessLeave: boolean
  salaryType: EmployeePayoutMethod
  /// When false, OT is disabled entirely for employees on this policy.
  /// `otMethod` is still stored (for legacy continuity) but the OT
  /// dropdown / approval UI is hidden and the value is ignored.
  otEnabled: boolean
  otMethod: OtPayoutMethod
  /// When true, employees must be inside the project geofence to clock
  /// in. Radius is configured per project; this flag only decides
  /// whether the check is enforced for this policy's employees.
  requireGeofence: boolean
  /// When true, employees must be connected from an IP in the project's
  /// `allowedIps` list to clock in. Off-site remark override same as
  /// geofence. Silently skipped for projects with no IPs configured.
  requireIpWhitelist: boolean
  /// Master switch for capturing GPS coords on attendance events.
  /// Auto-enabled by the server when `requireGeofence` is turned on.
  geolocationEnabled: boolean
  /// Per-event capture flags — only consulted when geolocationEnabled
  /// is true. Default true on freshly-created policies.
  captureLocationOnClockIn: boolean
  captureLocationOnClockOut: boolean
  captureLocationOnBreakStart: boolean
  captureLocationOnBreakEnd: boolean
  /// When true, the clock-in flow gates on a selfie capture. Replaces
  /// the legacy "Hourly Worker == selfie required" hardcoding.
  requireSelfie: boolean
  /// When true, the clock-out flow (and the 10 pm OT remark card) also
  /// require a selfie before the employee can proceed.
  requireClockOutSelfie: boolean
  /// When true, employees on this policy are temporary (probation /
  /// fixed-term). Enables the per-employee `temporaryReviewDate` field
  /// and the admin review reminder.
  temporary: boolean
  /// When true, open attendance sessions are automatically closed by the
  /// cron sweep once the employee has been clocked in for `autoClockOutAfterMin`
  /// minutes. Null threshold = feature on but no time limit (not useful; the
  /// admin should always set a threshold when enabling).
  autoClockOutEnabled: boolean
  autoClockOutAfterMin: number | null
  /// OT multipliers, salary cap, and daily threshold. Applied only when
  /// `otEnabled && otMethod === "CASH"`. Always present in the DB row;
  /// the calc engine ignores them outside CASH mode.
  otRateNormalDay: number
  otRateRestDay: number
  otRatePublicHoliday: number
  otRateRestDayInShift: number
  otRatePublicHolidayInShift: number
  /// Optional monthly-salary cap above which OT requires extra
  /// approval. `null` means no cap is enforced.
  otSalaryThreshold: number | null
  otDailyThresholdMinutes: number
  /// Number of employees currently assigned. Populated by the
  /// `listForOrganization` query; undefined elsewhere.
  employeeCount?: number
}

/// Project an `EmployeePolicy` row into the shared `OtRates` shape used
/// by the payroll calc engine. Returned values are always populated;
/// callers should still gate on `policy.otEnabled && otMethod === "CASH"`
/// before applying them.
export function otRatesFromPolicy(policy: EmployeePolicy): OtRates {
  return {
    normalDay: policy.otRateNormalDay,
    restDay: policy.otRateRestDay,
    publicHoliday: policy.otRatePublicHoliday,
    restDayInShift: policy.otRateRestDayInShift,
    publicHolidayInShift: policy.otRatePublicHolidayInShift,
    salaryThreshold: policy.otSalaryThreshold,
    dailyThresholdMinutes: policy.otDailyThresholdMinutes,
  }
}

/// Effective module-access flags resolved for one employee. Drives nav
/// rendering and route guards in the employee portal. Falls back to
/// "everything visible" when the employee has no policy assigned (legacy
/// rows that pre-date the backfill).
export type EmployeeModuleAccess = {
  attendance: boolean
  claims: boolean
  leave: boolean
}

export const DEFAULT_MODULE_ACCESS: EmployeeModuleAccess = {
  attendance: true,
  claims: true,
  leave: true,
}

export function moduleAccessForPolicy(
  policy: Pick<
    EmployeePolicy,
    "canAccessAttendance" | "canAccessClaims" | "canAccessLeave"
  > | null
  | undefined,
): EmployeeModuleAccess {
  if (!policy) return DEFAULT_MODULE_ACCESS
  return {
    attendance: policy.canAccessAttendance,
    claims: policy.canAccessClaims,
    leave: policy.canAccessLeave,
  }
}
