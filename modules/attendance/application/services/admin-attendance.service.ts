import "server-only"

import type {
  AdminOrgOverview,
  ApprovalRequestView,
} from "@/modules/attendance/domain/models"
import {
  mockOrgOverview,
  mockPendingApprovals,
} from "@/modules/attendance/infrastructure/mock-data"

// TODO(step-4): replace mock returns with attendanceRepository calls.

export const adminAttendanceService = {
  async getOrgOverview(): Promise<AdminOrgOverview> {
    return mockOrgOverview
  },

  async getAllPendingApprovals(): Promise<ApprovalRequestView[]> {
    return mockPendingApprovals
  },

  async getAggregateStats(_from: Date, _to: Date): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    return {
      totalAttendanceRecords: 4_280,
      totalLate: 187,
      totalMissing: 24,
      totalOnLeave: 96,
      pendingOT: mockPendingApprovals.length,
    }
  },
}
