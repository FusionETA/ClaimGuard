import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  AdminOrgOverview,
  ApprovalRequestView,
  TodayRollCall,
} from "@/modules/attendance/domain/models"
import {
  loadEmployeeDetailForAdmin,
  loadOrgEmployeeListForAdmin,
} from "./employee-detail-loader"

export const adminAttendanceService = {
  async getOrgOverview(orgId: string | null): Promise<AdminOrgOverview> {
    return attendanceRepository.getOrgOverview(orgId)
  },

  async getTodayRollCall(orgId: string | null): Promise<TodayRollCall> {
    return attendanceRepository.getTodayRollCall(orgId)
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

  async getOrgTimezone(orgId: string | null): Promise<string> {
    return attendanceRepository.getOrgTimezone(orgId)
  },

  async getEmployeeList(orgId: string | null) {
    return loadOrgEmployeeListForAdmin(orgId)
  },

  async getEmployeeDetail(adminOrgId: string | null, employeeId: string) {
    return loadEmployeeDetailForAdmin(adminOrgId, employeeId)
  },

  async getOrgHoursSummary(orgId: string | null, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ orgId, from, to })
  },

  async getEmployeeHoursSummary(employeeId: string, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ employeeId, from, to })
  },
}
