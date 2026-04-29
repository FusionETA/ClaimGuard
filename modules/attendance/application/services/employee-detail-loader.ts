import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type { EmployeeDetailData } from "@/components/attendance/employee-detail-view"

export async function loadEmployeeDetail(
  employeeId: string,
): Promise<EmployeeDetailData | null> {
  const profile = await attendanceRepository.getEmployeeProfile(employeeId)
  if (!profile) return null

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [todayRecord, todayEvents, history, otRecords, monthSummary] = await Promise.all(
    [
      attendanceRepository.getTodayAttendance(employeeId),
      attendanceRepository.getTodayEvents(employeeId),
      attendanceRepository.getAttendanceHistory(employeeId, thirtyDaysAgo, now),
      attendanceRepository.getEmployeeOTApprovals(employeeId),
      attendanceRepository.getEmployeeMonthSummary(employeeId, monthStart),
    ],
  )

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
    monthSummary,
    history,
    otRecords,
  }
}

export async function loadOrgEmployeeListForAdmin(orgId: string | null) {
  return attendanceRepository.getOrgEmployeeList(orgId)
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
