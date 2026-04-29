import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  AdminOrgOverview,
  ApprovalRequestView,
} from "@/modules/attendance/domain/models"

export const adminAttendanceService = {
  async getOrgOverview(orgId: string | null): Promise<AdminOrgOverview> {
    return attendanceRepository.getOrgOverview(orgId)
  },

  async getAllPendingApprovals(orgId: string | null): Promise<ApprovalRequestView[]> {
    return attendanceRepository.getAllPendingApprovals(orgId)
  },

  async getAggregateStats(
    from: Date,
    to: Date,
    orgId: string | null,
  ): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    return attendanceRepository.getAggregateStats(from, to, orgId)
  },

  async getWorkingHours(orgId: string | null): Promise<{ start: string; end: string }> {
    return attendanceRepository.getWorkingHours(orgId)
  },

  async setWorkingHours(orgId: string, start: string, end: string): Promise<void> {
    await attendanceRepository.setWorkingHours(orgId, start, end)
  },
}
