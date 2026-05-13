import type {
  EmployeePayoutMethod,
  OtPayoutMethod,
} from "@/modules/organization/domain/models"

/// Admin-configurable classification for an employee. Replaces the previous
/// hardcoded "Hourly Worker" / "Office Worker" pair. The policy is the
/// admin-facing source of truth; the denormalized `payoutMethod` and
/// `otPayoutMethod` columns on `EmployeeProfile` are kept in sync with it
/// so legacy attendance/payroll code paths keep working unchanged.
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
  /// Number of employees currently assigned. Populated by the
  /// `listForOrganization` query; undefined elsewhere.
  employeeCount?: number
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
