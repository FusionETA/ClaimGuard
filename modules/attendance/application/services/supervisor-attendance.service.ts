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
    options?: { notes?: string | null; overrideEventAt?: Date | null },
  ): Promise<void> {
    await attendanceRepository.reviewApproval(
      approvalId,
      supervisorId,
      status,
      options?.notes ?? undefined,
      options?.overrideEventAt ?? null,
    )
  },

  async overrideAttendanceTimes(
    supervisorId: string,
    args: {
      attendanceRecordId: string
      employeeId: string
      timeIn?: Date | null
      timeOut?: Date | null
      reason?: string | null
    },
  ): Promise<void> {
    await attendanceRepository.assertSupervisorCanEditEmployee(
      supervisorId,
      args.employeeId,
    )
    await attendanceRepository.overrideAttendanceTimes({
      attendanceRecordId: args.attendanceRecordId,
      editorId: supervisorId,
      editorRole: "SUPERVISOR",
      source: "DIRECT_EDIT",
      timeIn: args.timeIn,
      timeOut: args.timeOut,
      reason: args.reason,
    })
  },

  /**
   * Whole-session edit: apply timeIn/timeOut overrides plus any
   * combination of break edits (update / create / delete) in one go.
   * Each individual repo call writes its own audit log row; the
   * `durationMin` recompute baked into the break helpers keeps the
   * derived field in sync at every step.
   *
   * Identity rule: existing breaks are matched by `id`. New breaks come
   * in without an `id`. Breaks present in the current record but absent
   * from `args.breaks` are deleted.
   */
  async editSession(
    supervisorId: string,
    args: {
      attendanceRecordId: string
      employeeId: string
      timeIn?: Date | null
      timeOut?: Date | null
      breaks: Array<{
        id?: string
        startedAt: Date
        endedAt: Date | null
      }>
      reason: string
      editorRole?: "ADMIN" | "SUPERVISOR"
    },
  ): Promise<void> {
    const role: "ADMIN" | "SUPERVISOR" = args.editorRole ?? "SUPERVISOR"
    if (role === "SUPERVISOR") {
      await attendanceRepository.assertSupervisorCanEditEmployee(
        supervisorId,
        args.employeeId,
      )
    }
    const reason = args.reason.trim() || null

    // 1) clock-in / clock-out (recomputes status, late, durationMin)
    if (args.timeIn !== undefined || args.timeOut !== undefined) {
      await attendanceRepository.overrideAttendanceTimes({
        attendanceRecordId: args.attendanceRecordId,
        editorId: supervisorId,
        editorRole: role,
        source: "DIRECT_EDIT",
        timeIn: args.timeIn,
        timeOut: args.timeOut,
        reason,
      })
    }

    // 2) breaks — diff against current rows
    const current = await attendanceRepository.getBreakSessionsForRecord(
      args.attendanceRecordId,
    )
    const incomingIds = new Set(
      args.breaks.filter((b) => b.id).map((b) => b.id as string),
    )
    for (const existing of current) {
      if (!incomingIds.has(existing.id)) {
        await attendanceRepository.deleteBreakSessionAsEditor({
          breakSessionId: existing.id,
          editorId: supervisorId,
          editorRole: role,
          reason,
        })
      }
    }
    for (const b of args.breaks) {
      if (b.id) {
        const existing = current.find((c) => c.id === b.id)
        if (!existing) continue
        const startedChanged = existing.startedAt.getTime() !== b.startedAt.getTime()
        const endedChanged =
          (existing.endedAt?.getTime() ?? null) !== (b.endedAt?.getTime() ?? null)
        if (startedChanged || endedChanged) {
          await attendanceRepository.overrideBreakSession({
            breakSessionId: b.id,
            editorId: supervisorId,
            editorRole: role,
            source: "DIRECT_EDIT",
            startedAt: startedChanged ? b.startedAt : undefined,
            endedAt: endedChanged ? b.endedAt : undefined,
            reason,
          })
        }
      } else {
        await attendanceRepository.createBreakSessionAsEditor({
          attendanceRecordId: args.attendanceRecordId,
          editorId: supervisorId,
          editorRole: role,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          reason,
        })
      }
    }
  },
}
