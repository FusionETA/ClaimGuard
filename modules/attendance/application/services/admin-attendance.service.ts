import "server-only"

import type {
  AdminOrgOverview,
  OTRequestView,
} from "@/modules/attendance/domain/models"

export const adminAttendanceService = {
  async getOrgOverview(): Promise<AdminOrgOverview> {
    throw new Error("adminAttendanceService.getOrgOverview: not implemented")
  },

  async getAllPendingApprovals(): Promise<OTRequestView[]> {
    throw new Error("adminAttendanceService.getAllPendingApprovals: not implemented")
  },

  async getAggregateStats(_from: Date, _to: Date): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    throw new Error("adminAttendanceService.getAggregateStats: not implemented")
  },
}
