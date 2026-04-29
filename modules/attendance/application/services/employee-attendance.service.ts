import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { getPrismaClient } from "@/lib/prisma"

export const employeeAttendanceService = {
  async getEmployeeDashboard(employeeId: string): Promise<EmployeeAttendanceDashboard> {
    const [today, weekToDate, todayEvents, recentOT] = await Promise.all([
      attendanceRepository.getTodayAttendance(employeeId),
      attendanceRepository.getWeekAttendance(employeeId),
      attendanceRepository.getTodayEvents(employeeId),
      attendanceRepository.getEmployeeOTApprovals(employeeId),
    ])
    return { today, weekToDate, todayEvents, recentOT }
  },

  async getEmployeeHistory(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<AttendanceRecordView[]> {
    return attendanceRepository.getAttendanceHistory(employeeId, from, to)
  },

  async getEmployeeOTRecords(employeeId: string): Promise<ApprovalRequestView[]> {
    return attendanceRepository.getEmployeeOTApprovals(employeeId)
  },

  async getWorkingHours(employeeId: string): Promise<{ start: string; end: string }> {
    const prisma = getPrismaClient()
    if (!prisma) return { start: "09:00", end: "18:00" }
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true },
    })
    return attendanceRepository.getWorkingHours(user?.organizationId ?? null)
  },

  async clockIn(employeeId: string) {
    return attendanceRepository.clockIn(employeeId)
  },

  async clockOut(employeeId: string) {
    return attendanceRepository.clockOut(employeeId)
  },

  async confirmBreak(employeeId: string) {
    return attendanceRepository.confirmBreak(employeeId)
  },
}
