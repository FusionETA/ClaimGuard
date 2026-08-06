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

export type TeamReportAccess =
  | { ok: true; orgId: string; userIds: string[] | null }
  | { ok: false; status: number; message: string }

/**
 * Authorises a WHOLE-TEAM Leave / Attendance report for the current session
 * and returns the employee filter for the bulk PDF generators:
 *
 *   - ADMIN / OWNER: the whole org (`userIds: null` → the bulk generators
 *     render every employee, no filter).
 *   - SUPERVISOR: the employees in their approval chain (their team); 404
 *     when they have none.
 *   - anyone else: 403.
 */
export async function resolveTeamReportAccess(): Promise<TeamReportAccess> {
  const session = await getCurrentSession()
  if (!session) return { ok: false, status: 401, message: "Unauthorized." }

  const orgId = resolveActiveOrgId(session)
  if (!orgId) {
    return { ok: false, status: 400, message: "No active organization." }
  }

  if (isAdminRole(session.role)) return { ok: true, orgId, userIds: null }

  if (session.role === "SUPERVISOR") {
    const userIds = await attendanceRepository.getTeamMemberIds(session.userId)
    if (userIds.length === 0) {
      return {
        ok: false,
        status: 404,
        message: "You have no team members to report on.",
      }
    }
    return { ok: true, orgId, userIds }
  }

  return {
    ok: false,
    status: 403,
    message: "Only supervisors and admins can download team reports.",
  }
}
