import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  AttendanceRecordView,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"

export const supervisorAttendanceService = {
  async getTeamOverview(supervisorId: string): Promise<SupervisorTeamOverview> {
    return attendanceRepository.getTeamOverview(supervisorId)
  },

  async getPendingApprovalsForSupervisor(
    supervisorId: string,
  ): Promise<ApprovalRequestView[]> {
    return attendanceRepository.getPendingApprovalsForSupervisor(supervisorId)
  },

  async countPendingApprovalsForSupervisor(supervisorId: string): Promise<number> {
    return attendanceRepository.countPendingApprovalsForSupervisor(supervisorId)
  },

  async getEmployeeDrilldown(
    _supervisorId: string,
    employeeId: string,
  ): Promise<{
    history: AttendanceRecordView[]
    otRecords: ApprovalRequestView[]
  }> {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const [history, otRecords] = await Promise.all([
      attendanceRepository.getAttendanceHistory(employeeId, thirtyDaysAgo, now),
      attendanceRepository.getEmployeeOTApprovals(employeeId),
    ])
    return { history, otRecords }
  },

  async reviewApproval(
    supervisorId: string,
    approvalId: string,
    status: "APPROVED" | "REJECTED",
  ): Promise<void> {
    await attendanceRepository.reviewApproval(approvalId, supervisorId, status)
  },
}
