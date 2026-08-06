import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type { EmployeeDetailData } from "@/modules/attendance/domain/models"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
import { getApprovedLeaveDaysInRangeForUser } from "@/modules/leave/application/services/leave-overview.service"

export async function loadEmployeeDetail(
  employeeId: string,
): Promise<EmployeeDetailData | null> {
  const profile = await attendanceRepository.getEmployeeProfile(employeeId)
  if (!profile) return null

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59),
  )
  // Recent-attendance list looks back ~1 month; the panel paginates and
  // date-filters this window client-side. (Admin + supervisor share the view
  // and the supervisor page has no server-side range action to lean on, so a
  // one-shot load beats wiring a paged action through both flows.)
  const historyStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [todayRecord, todayEvents, history, otRecords, monthSummary, onLeaveDays] =
    await Promise.all([
      attendanceRepository.getTodayAttendance(employeeId),
      attendanceRepository.getTodayEvents(employeeId),
      attendanceRepository.getAttendanceHistory(employeeId, historyStart, now),
      attendanceRepository.getEmployeeOTApprovals(employeeId),
      attendanceRepository.getEmployeeMonthSummary(employeeId, monthStart),
      // employeeId here is the User id (attendance keys on User.id); the leave
      // helper joins via employee.userId.
      getApprovedLeaveDaysInRangeForUser(employeeId, monthStart, monthEnd),
    ])

  return {
    profile: {
      name: profile.name,
      email: profile.email,
      role: profile.role,
      initials: profile.initials,
      jobTitle: profile.jobTitle,
      project: profile.project,
      employeeIdRef: profile.employeeIdRef,
      supervisorName: profile.supervisorName,
    },
    todayRecord,
    todayEvents,
    monthSummary: { ...monthSummary, onLeave: onLeaveDays },
    history,
    otRecords,
  }
}

export async function loadOrgEmployeeListForAdmin(orgId: string | null) {
  const policyIdScope = await getActiveAdminPolicyScope()
  return attendanceRepository.getOrgEmployeeList(orgId, { policyIdScope })
}

export async function loadEmployeeDetailForAdmin(
  adminOrgId: string | null,
  employeeId: string,
): Promise<EmployeeDetailData | null> {
  const profile = await attendanceRepository.getEmployeeProfile(employeeId)
  if (!profile) return null
  // Scope: admins can only view employees in their own org (if assigned).
  if (adminOrgId && profile.organizationId !== adminOrgId) return null
  return loadEmployeeDetail(employeeId)
}
