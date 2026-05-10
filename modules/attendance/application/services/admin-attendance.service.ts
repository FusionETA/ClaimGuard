import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { key } from "@/lib/redis"
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

/**
 * Build a stable, cache-safe segment from a nullable filter value.
 * Cache keys must be deterministic — two requests with the same logical
 * filter must hash to the same key. `null`/`undefined`/empty-string are
 * normalised to a single sentinel ("_") so they don't fork the cache.
 */
function seg(v: string | null | undefined): string {
  return v && v.length > 0 ? v : "_"
}

export const adminAttendanceService = {
  async getOrgOverview(
    orgId: string | null,
    projectId?: string | null,
  ): Promise<AdminOrgOverview> {
    return getOrSetCache(
      key("org", seg(orgId), "attendance", "overview", seg(projectId)),
      60,
      () => attendanceRepository.getOrgOverview(orgId, projectId),
    )
  },

  async getTodayRollCall(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ): Promise<TodayRollCall> {
    // "Today" — include date so caches don't survive a midnight rollover.
    const today = new Date().toISOString().slice(0, 10)
    return getOrSetCache(
      key(
        "org",
        seg(orgId),
        "attendance",
        "rollcall",
        today,
        seg(projectId),
        seg(teamId),
        seg(q),
      ),
      60,
      () => attendanceRepository.getTodayRollCall(orgId, projectId, teamId, q),
    )
  },

  async getAllPendingApprovals(orgId: string | null): Promise<ApprovalRequestView[]> {
    return getOrSetCache(
      key("org", seg(orgId), "attendance", "pending-approvals"),
      60,
      () => attendanceRepository.getAllPendingApprovals(orgId),
    )
  },

  async getAggregateStats(
    from: Date,
    to: Date,
    orgId: string | null,
    projectId?: string | null,
  ): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    return getOrSetCache(
      key(
        "org",
        seg(orgId),
        "attendance",
        "stats",
        from.toISOString(),
        to.toISOString(),
        seg(projectId),
      ),
      60,
      () => attendanceRepository.getAggregateStats(from, to, orgId, projectId),
    )
  },

  async getWorkingHours(orgId: string | null): Promise<{ start: string; end: string }> {
    // Working hours change rarely — longer TTL (10min). Mutation
    // invalidates explicitly via `setWorkingHoursAction`.
    return getOrSetCache(
      key("org", seg(orgId), "attendance", "working-hours"),
      600,
      () => attendanceRepository.getWorkingHours(orgId),
    )
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

  async getOrgHoursSummary(
    orgId: string | null,
    from: Date,
    to: Date,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ) {
    return attendanceRepository.getHoursSummary({
      orgId,
      from,
      to,
      projectId,
      teamId,
      q,
    })
  },

  async getEmployeeHoursSummary(employeeId: string, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ employeeId, from, to })
  },

  async getDailyActivity(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ) {
    return attendanceRepository.getDailyActivity(orgId, projectId, teamId, q)
  },

  async getSupervisorPerformance(args: {
    orgId: string | null
    from: Date
    to: Date
    slaMinutes: number
    projectId?: string | null
    teamId?: string | null
    q?: string | null
  }) {
    return attendanceRepository.getSupervisorPerformance(args)
  },

  async getApprovalAuditLog(
    orgId: string | null,
    from: Date,
    to: Date,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ) {
    return attendanceRepository.getApprovalAuditLog({
      orgId,
      from,
      to,
      projectId,
      teamId,
      q,
    })
  },
}
