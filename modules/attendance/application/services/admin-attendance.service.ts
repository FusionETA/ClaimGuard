import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { key } from "@/lib/redis"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
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

/**
 * Derive a deterministic cache-key segment from the per-admin policy
 * scope. `null` = full access (owner / legacy) shares the original cache
 * entries (no scope tag); a restricted scope sorts + joins the IDs so
 * `{a,b}` and `{b,a}` land on the same key.
 */
function scopeSeg(policyIdScope: string[] | null): string {
  if (policyIdScope === null) return "_all"
  if (policyIdScope.length === 0) return "_none"
  return `p:${[...policyIdScope].sort().join(",")}`
}

export const adminAttendanceService = {
  async getOrgOverview(
    orgId: string | null,
    projectId?: string | null,
  ): Promise<AdminOrgOverview> {
    const policyIdScope = await getActiveAdminPolicyScope()
    return getOrSetCache(
      key(
        "org",
        seg(orgId),
        "attendance",
        "overview",
        seg(projectId),
        scopeSeg(policyIdScope),
      ),
      60,
      () =>
        attendanceRepository.getOrgOverview(orgId, projectId, {
          policyIdScope,
        }),
    )
  },

  async getTodayRollCall(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ): Promise<TodayRollCall> {
    const policyIdScope = await getActiveAdminPolicyScope()
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
        scopeSeg(policyIdScope),
      ),
      60,
      () =>
        attendanceRepository.getTodayRollCall(orgId, projectId, teamId, q, {
          policyIdScope,
        }),
    )
  },

  async getAllPendingApprovals(orgId: string | null): Promise<ApprovalRequestView[]> {
    const policyIdScope = await getActiveAdminPolicyScope()
    return getOrSetCache(
      key(
        "org",
        seg(orgId),
        "attendance",
        "pending-approvals",
        scopeSeg(policyIdScope),
      ),
      60,
      () =>
        attendanceRepository.getAllPendingApprovals(orgId, {
          policyIdScope,
        }),
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
    const policyIdScope = await getActiveAdminPolicyScope()
    return getOrSetCache(
      key(
        "org",
        seg(orgId),
        "attendance",
        "stats",
        from.toISOString(),
        to.toISOString(),
        seg(projectId),
        scopeSeg(policyIdScope),
      ),
      60,
      () =>
        attendanceRepository.getAggregateStats(from, to, orgId, projectId, {
          policyIdScope,
        }),
    )
  },

  async getWorkingHours(orgId: string | null): Promise<{ start: string; end: string }> {
    // Working hours change almost never — 1-hour TTL. Mutation
    // invalidates explicitly via `setWorkingHoursAction` (calls
    // `bustAttendanceCaches`), so the TTL is just a safety net.
    return getOrSetCache(
      key("org", seg(orgId), "attendance", "working-hours"),
      3600,
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
    const policyIdScope = await getActiveAdminPolicyScope()
    return attendanceRepository.getHoursSummary({
      orgId,
      from,
      to,
      projectId,
      teamId,
      q,
      policyIdScope,
    })
  },

  async getEmployeeHoursSummary(employeeId: string, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ employeeId, from, to })
  },

  /// Weekly + monthly actual-vs-expected progress for a single employee,
  /// used by the admin/supervisor employee-detail page.
  async getEmployeeProgress(employeeId: string) {
    return employeeAttendanceService.getProgress(employeeId)
  },

  async getDailyActivity(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ) {
    const policyIdScope = await getActiveAdminPolicyScope()
    return attendanceRepository.getDailyActivity(orgId, projectId, teamId, q, {
      policyIdScope,
    })
  },

  async getOffSiteClockIns(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
  ) {
    const policyIdScope = await getActiveAdminPolicyScope()
    return attendanceRepository.getOffSiteClockInsForToday(
      orgId,
      projectId,
      teamId,
      q,
      { policyIdScope },
    )
  },

  async overrideAttendanceTimes(
    adminId: string,
    args: {
      attendanceRecordId: string
      employeeOrgId: string | null
      adminOrgId: string | null
      timeIn?: Date | null
      timeOut?: Date | null
      reason?: string | null
    },
  ): Promise<void> {
    if (!args.adminOrgId || args.adminOrgId !== args.employeeOrgId) {
      throw new Error("You can only edit attendance for employees in your organisation.")
    }
    await attendanceRepository.overrideAttendanceTimes({
      attendanceRecordId: args.attendanceRecordId,
      editorId: adminId,
      editorRole: "ADMIN",
      source: "DIRECT_EDIT",
      timeIn: args.timeIn,
      timeOut: args.timeOut,
      reason: args.reason,
    })
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
    const policyIdScope = await getActiveAdminPolicyScope()
    return attendanceRepository.getSupervisorPerformance({
      ...args,
      policyIdScope,
    })
  },

  async getApprovalAuditLog(
    orgId: string | null,
    from: Date,
    to: Date,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
    statuses?: Array<"APPROVED" | "REJECTED" | "PENDING">,
  ) {
    const policyIdScope = await getActiveAdminPolicyScope()
    return attendanceRepository.getApprovalAuditLog({
      orgId,
      from,
      to,
      projectId,
      teamId,
      q,
      statuses,
      policyIdScope,
    })
  },

  async getOrgHistory(args: {
    orgId: string | null
    from: Date
    to: Date
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    statuses?: string[]
    page: number
    policyIdScope?: string[] | null
  }) {
    return attendanceRepository.getOrgAttendanceHistory({
      ...args,
      pageSize: 50,
    })
  },
}
