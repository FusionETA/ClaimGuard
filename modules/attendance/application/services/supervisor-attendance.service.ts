import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"
import { loadEmployeeDetail } from "./employee-detail-loader"

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

  async getEmployeeDetail(supervisorId: string, employeeId: string) {
    // Verify the employee is a direct report of this supervisor.
    const teamIds = await attendanceRepository.getTeamMemberIds(supervisorId)
    if (!teamIds.includes(employeeId)) return null

    return loadEmployeeDetail(employeeId)
  },

  async reviewApproval(
    supervisorId: string,
    approvalId: string,
    status: "APPROVED" | "REJECTED",
  ): Promise<void> {
    await attendanceRepository.reviewApproval(approvalId, supervisorId, status)
  },
}
