import "server-only"

import { bustAttendanceCaches } from "@/lib/cache-invalidation"
import { publishUserEvents } from "@/lib/realtime"
import { writeAuditByUserId } from "@/modules/audit/application/services/audit-log.service"
import { notify } from "@/modules/notifications/application/services/notification.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import {
  shiftRepository,
  type SupervisedMembershipShift,
} from "@/modules/attendance/infrastructure/shift.repository"
import type {
  ApprovalRequestView,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"
import { loadEmployeeDetail } from "./employee-detail-loader"

/** Human label for an approval kind, used in notification bodies. */
function approvalKindLabel(kind: string): string {
  switch (kind) {
    case "CLOCK_IN":
      return "clock-in"
    case "CLOCK_OUT":
      return "clock-out"
    case "BREAK":
      return "break"
    case "OT":
      return "overtime"
    default:
      return "attendance"
  }
}

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
    options?: { notes?: string | null; overrideEventAt?: Date | null; otSubtype?: string | null },
  ): Promise<void> {
    const validSubtypes = ["LATE_REPLACEMENT", "OT_OFFSET", "UNRESOLVED"] as const
    type OTSubtype = (typeof validSubtypes)[number]
    const otSubtype =
      options?.otSubtype && (validSubtypes as readonly string[]).includes(options.otSubtype)
        ? (options.otSubtype as OTSubtype)
        : null
    const result = await attendanceRepository.reviewApproval(
      approvalId,
      supervisorId,
      status,
      options?.notes ?? undefined,
      options?.overrideEventAt ?? null,
      otSubtype,
    )

    // Realtime fan-out:
    //   - Everyone whose attendance queue changed — the next-step
    //     approvers (request advanced to them) AND the peers at the step
    //     just acted on — gets a SILENT live refresh. Deliberately NO
    //     per-event push to approvers: a supervisor with many reports
    //     would be flooded. The digest cron owns the batched
    //     "you have N pending" push/bell.
    //   - On the FINAL decision, the EMPLOYEE also gets a silent SSE
    //     refresh so their clock card's "Waiting on supervisor" banner
    //     disappears and the disabled Clock Out / Break buttons re-enable
    //     without a manual page reload. They also get a direct push +
    //     persisted notification (below) telling them the outcome.
    try {
      const refreshTargets = [
        ...result.nextApproverIds,
        ...result.peerApproverIds,
      ]
      if (result.finalStatus !== "PENDING") {
        // Final approve/reject changes what the employee's dashboard
        // shows — push them an SSE event so the page hot-refreshes.
        refreshTargets.push(result.employeeUserId)
      }
      // Bust the requesting employee's per-user attendance cache BEFORE
      // publishing — otherwise the SSE message reaches the browser,
      // fires `router.refresh()`, and the server hits Redis while the
      // bust is still in flight, returning the cached "Waiting on
      // supervisor" payload. The action layer only knows the
      // supervisor's org id, so without this the employee's
      // `user:{id}:attendance:dashboard:{date}` cache (60s TTL)
      // survives the approval and the page would otherwise show the
      // stale state until the TTL expires.
      await bustAttendanceCaches({ employeeUserId: result.employeeUserId })
      await publishUserEvents(refreshTargets, {
        type: "refresh",
        scope: "attendance",
      })
      if (result.finalStatus === "REJECTED") {
        await notify({
          userId: result.employeeUserId,
          type: "ATTENDANCE_APPROVAL",
          title: "Attendance Rejected",
          body: `Your ${approvalKindLabel(result.kind)} request was rejected.`,
          url: "/employee/attendance",
        })
      }
    } catch {
      // Realtime / notifications must never block a successful review.
    }

    // Audit: capture every reviewer decision (supervisor + final
    // step alike). The orgId lookup is one extra query but the
    // result type doesn't carry it; cheap + fire-and-forget.
    try {
      const orgId = await attendanceRepository.getOrganizationIdForUser(
        supervisorId,
      )
      if (orgId) {
        void writeAuditByUserId({
          organizationId: orgId,
          actorUserId: supervisorId,
          action:
            status === "APPROVED"
              ? "attendance.approve"
              : "attendance.reject",
          status: "SUCCESS",
          summary:
            status === "APPROVED"
              ? `Approved ${approvalKindLabel(result.kind)} request${
                  result.finalStatus === "APPROVED" ? " (final)" : ""
                }`
              : `Rejected ${approvalKindLabel(result.kind)} request`,
          targetType: "approvalRequest",
          targetId: approvalId,
          metadata: options?.notes ? { notes: options.notes } : null,
        })
      }
    } catch {
      // Audit miss must never block a successful review.
    }
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
    const result = await attendanceRepository.overrideAttendanceTimes({
      attendanceRecordId: args.attendanceRecordId,
      editorId: supervisorId,
      editorRole: "SUPERVISOR",
      source: "DIRECT_EDIT",
      timeIn: args.timeIn,
      timeOut: args.timeOut,
      reason: args.reason,
    })
    // If the override auto-created a pending OT request, nudge the
    // first-step approvers so their sidebar badge updates live (same
    // pattern as clock-in/out flows).
    if (result.pendingApproverIds.length > 0) {
      try {
        await publishUserEvents(result.pendingApproverIds, {
          type: "refresh",
          scope: "attendance",
        })
      } catch {
        // Realtime never blocks a successful edit.
      }
    }
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

    // 1) clock-in / clock-out (recomputes status, late, durationMin).
    // Collect any auto-OT approver IDs returned so we can fan-out a
    // realtime refresh below (the editor can also create a new OT
    // request if the recomputed duration exceeds the daily threshold).
    let otApproverIds: string[] = []
    if (args.timeIn !== undefined || args.timeOut !== undefined) {
      const overrideResult = await attendanceRepository.overrideAttendanceTimes({
        attendanceRecordId: args.attendanceRecordId,
        editorId: supervisorId,
        editorRole: role,
        source: "DIRECT_EDIT",
        timeIn: args.timeIn,
        timeOut: args.timeOut,
        reason,
      })
      otApproverIds = overrideResult.pendingApproverIds
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

    // 3) Realtime fan-out for any auto-OT request created above. Same
    // pattern as clockIn/clockOut + reviewApproval — fail-soft so a
    // Redis hiccup never blocks the edit itself.
    if (otApproverIds.length > 0) {
      try {
        await publishUserEvents(otApproverIds, {
          type: "refresh",
          scope: "attendance",
        })
      } catch {
        // Realtime never blocks a successful edit.
      }
    }
  },

  // ─── Shift assignment (Phase 5) ────────────────────────────────────

  /**
   * List every EmployeeTeamMembership the supervisor manages that
   * involves the target employee. Empty list = supervisor doesn't
   * manage this employee at all (page should surface a 403).
   *
   * The repo query joins the available shift pool per team's project
   * so the client picker never needs a follow-up round trip.
   */
  async listShiftAssignmentsForEmployee(
    supervisorUserId: string,
    targetUserId: string,
  ): Promise<SupervisedMembershipShift[]> {
    return shiftRepository.listSupervisedMembershipsWithShifts({
      supervisorUserId,
      targetUserId,
    })
  },

  /**
   * Assign a specific shift (or clear it, pass shiftId=null) to a
   * membership. Delegates the auth check to the repo — supervisor
   * must sit on the approval chain for the membership's team, and
   * the shift must belong to that team's project.
   *
   * `organizationId` is looked up from the current session before
   * calling; the repo receives it as an extra tx guard.
   */
  async assignShiftToMembership(input: {
    supervisorUserId: string
    organizationId: string
    membershipId: string
    shiftId: string | null
  }): Promise<
    | { ok: true }
    | {
        ok: false
        code:
          | "NOT_SUPERVISOR"
          | "WRONG_ORG"
          | "SHIFT_WRONG_PROJECT"
          | "NOT_FOUND"
      }
  > {
    return shiftRepository.assignShiftToMembership(input)
  },
}
