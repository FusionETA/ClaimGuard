import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"

export type ReportAccess =
  | { ok: true; orgId: string }
  | { ok: false; status: number; message: string }

/**
 * Authorises a per-employee Leave / Attendance report download for the
 * CURRENT session, returning the org id to render the report for:
 *
 *   - ADMIN / OWNER (incl. superadmin support mode): any employee in the
 *     active org.
 *   - Anyone: their OWN report (`employeeId === session.userId`).
 *   - SUPERVISOR: any employee in their approval chain (their team), via
 *     `getTeamMemberIds`.
 *
 * The org boundary itself is still enforced downstream — `generateAttendancePdf`
 * / `generateLeaveSummaryPdf` throw "Employee not found in this organization"
 * when the employee isn't in `orgId` — so this layer only adds the INTRA-org
 * scope (which employees each role may pull). Shared by the attendance and
 * leave export routes so the access rule lives in exactly one place.
 */
export async function resolveEmployeeReportAccess(
  employeeId: string,
): Promise<ReportAccess> {
  const session = await getCurrentSession()
  if (!session) return { ok: false, status: 401, message: "Unauthorized." }

  const orgId = resolveActiveOrgId(session)
  if (!orgId) {
    return { ok: false, status: 400, message: "No active organization." }
  }

  // Admins/owners: anyone in their (active) org.
  if (isAdminRole(session.role)) return { ok: true, orgId }

  // Anyone: their own report.
  if (employeeId === session.userId) return { ok: true, orgId }

  // Supervisors: only their direct reports (the employees whose approval
  // chain includes them).
  if (session.role === "SUPERVISOR") {
    const teamIds = await attendanceRepository.getTeamMemberIds(session.userId)
    if (teamIds.includes(employeeId)) return { ok: true, orgId }
  }

  return {
    ok: false,
    status: 403,
    message: "You don't have access to this employee's report.",
  }
}
