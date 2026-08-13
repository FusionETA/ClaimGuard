import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { buildInitials } from "@/lib/utils"
import type {
  AdminOrgOverview,
  ApprovalKind,
  ApprovalRequestView,
  ApprovalStatus,
  AttendanceRecordView,
  AttendanceSessionView,
  AttendanceStatus,
  ClockEventLite,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"
import {
  DEFAULT_LUNCH_BREAK_MIN,
  EMPTY_BUCKETS,
  addBuckets,
  bucketRecord,
  expectedMinutesForRange,
  formatHm,
  isoWeekday,
  parseWorkingDays,
  standardDailyMinutesFrom,
  type HoursBuckets,
} from "@/modules/attendance/domain/hours-summary"
import {
  DEFAULT_TIMEZONE,
  expectedTimeOnLocalDay as expectedTimeOnLocalDayInTz,
  formatLocalHm,
  startOfLocalDay,
} from "@/modules/attendance/domain/timezone"
import {
  shouldAutoApprove,
  resolveApprovalContext,
} from "@/modules/attendance/infrastructure/approval-chain-context"
import type { ChainHistoryEntry } from "@/modules/attendance/domain/models"
import {
  employeeProfileIdForUserId,
  paidLeaveMinutes,
} from "@/modules/leave/application/services/leave-balance.service"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClient() {
  const prisma = getPrismaClient()
  if (!prisma) {
    throw new Error("Database is not configured")
  }
  return prisma
}

/**
 * Module-scoped Prisma accessor for the attendance module. Services
 * call this instead of `getPrismaClient()` from `@/lib/prisma` so all
 * attendance-related DB access flows through the infrastructure layer.
 *
 * Throws when the database isn't configured. Use
 * `getAttendancePrismaClientSafe` for paths that should render an
 * empty state instead of throwing.
 */
export function getAttendancePrismaClient() {
  return getClient()
}

export function getAttendancePrismaClientSafe() {
  return getPrismaClient()
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date) {
  const x = new Date(d)
  x.setUTCHours(23, 59, 59, 999)
  return x
}

function diffMinutes(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / 60000)
}

// Title formatter helper: defers to org timezone (resolved at call sites)
function localHm(d: Date, tz: string): string {
  return formatLocalHm(d, tz)
}

function expectedTimeOnLocalDay(now: Date, hhmm: string, tz: string): Date {
  return expectedTimeOnLocalDayInTz(now, hhmm, tz)
}

/**
 * Older clock-in approvals were created before lateMinutes was being copied
 * onto the ApprovalRequest. For any CLOCK_IN row missing lateMinutes, look up
 * the matching AttendanceRecord.lateByMin so the supervisor still sees the
 * Late badge.
 */
/// Joins CLOCK_IN and CLOCK_OUT views to their AttendanceRecord to fill:
/// - lateMinutes (CLOCK_IN legacy backfill)
/// - selfieAttendanceRecordId (drives the supervisor/admin selfie thumbnail,
///   reads xeroSelfieFileId for clock-in, clockOutXeroSelfieFileId for clock-out)
/// Bails early when the view list contains no CLOCK_IN or CLOCK_OUT rows.
async function backfillLateMinutes(
  views: ApprovalRequestView[],
  prisma: ReturnType<typeof getClient>,
): Promise<ApprovalRequestView[]> {
  const targets = views.filter(
    (v) => v.kind === "CLOCK_IN" || v.kind === "CLOCK_OUT",
  )
  if (targets.length === 0) return views

  // Deduplicate by employeeId|date so we don't send duplicate OR clauses.
  const seenKeys = new Set<string>()
  const dedupedTargets = targets.filter((t) => {
    const key = `${t.employeeId}|${t.date}`
    if (seenKeys.has(key)) return false
    seenKeys.add(key)
    return true
  })

  const records = await prisma.attendanceRecord.findMany({
    where: {
      OR: dedupedTargets.map((t) => ({
        employeeId: t.employeeId,
        date: new Date(`${t.date}T00:00:00.000Z`),
      })),
    },
    select: {
      id: true,
      employeeId: true,
      date: true,
      lateByMin: true,
      xeroSelfieFileId: true,
      clockOutXeroSelfieFileId: true,
      clockInLat: true,
      clockInLng: true,
      clockOutLat: true,
      clockOutLng: true,
    },
  })
  type Meta = {
    recordId: string
    lateByMin: number | null
    xeroSelfieFileId: string | null
    clockOutXeroSelfieFileId: string | null
    clockInLat: number | null
    clockInLng: number | null
    clockOutLat: number | null
    clockOutLng: number | null
  }
  const lookup = new Map<string, Meta>()
  for (const r of records) {
    lookup.set(`${r.employeeId}|${r.date.toISOString().slice(0, 10)}`, {
      recordId: r.id,
      lateByMin: r.lateByMin,
      xeroSelfieFileId: r.xeroSelfieFileId,
      clockOutXeroSelfieFileId: r.clockOutXeroSelfieFileId,
      clockInLat: r.clockInLat,
      clockInLng: r.clockInLng,
      clockOutLat: r.clockOutLat,
      clockOutLng: r.clockOutLng,
    })
  }

  // For CLOCK_IN approvals, look up the per-session selfie via
  // clockInApprovalRequestId so multi-session days each show their own
  // selfie rather than the record-level field (which gets overwritten by
  // successive sessions on the same day).
  const clockInIds = targets
    .filter((v) => v.kind === "CLOCK_IN")
    .map((v) => v.id)
  const sessionByApprovalId = new Map<string, string>() // approvalId → sessionId
  if (clockInIds.length > 0) {
    const sessions = await prisma.attendanceSession.findMany({
      where: {
        clockInApprovalRequestId: { in: clockInIds },
        xeroSelfieFileId: { not: null },
      },
      select: { id: true, clockInApprovalRequestId: true },
    })
    for (const s of sessions) {
      if (s.clockInApprovalRequestId) {
        sessionByApprovalId.set(s.clockInApprovalRequestId, s.id)
      }
    }
  }

  return views.map((v) => {
    if (v.kind !== "CLOCK_IN" && v.kind !== "CLOCK_OUT") return v
    const meta = lookup.get(`${v.employeeId}|${v.date}`)
    if (!meta) return v
    if (v.kind === "CLOCK_IN") {
      // Prefer session-level selfie ID (correct for multi-session days).
      // Fall back to record-level for older approvals without a session link.
      const sessionId = sessionByApprovalId.get(v.id)
      const selfieAttendanceRecordId = sessionId
        ? sessionId
        : meta.xeroSelfieFileId
          ? meta.recordId
          : null
      return {
        ...v,
        lateMinutes:
          v.lateMinutes != null
            ? v.lateMinutes
            : meta.lateByMin && meta.lateByMin > 0
              ? meta.lateByMin
              : v.lateMinutes,
        selfieAttendanceRecordId,
        latitude: meta.clockInLat,
        longitude: meta.clockInLng,
      }
    }
    // CLOCK_OUT — fall back to clock-in coords if the clock-out point is missing.
    return {
      ...v,
      selfieAttendanceRecordId: meta.clockOutXeroSelfieFileId ? meta.recordId : null,
      latitude: meta.clockOutLat ?? meta.clockInLat,
      longitude: meta.clockOutLng ?? meta.clockInLng,
    }
  })
}

export const OFF_SITE_PREFIX = "⚠ OFF-SITE — "

function buildApprovalDetail(base: string, notes: string | undefined): string {
  if (!notes) return base
  return `${OFF_SITE_PREFIX}${base}\nRemark: ${notes}`
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

type PrismaAttendance = {
  id: string
  employeeId: string
  employee?: { name: string } | null
  date: Date
  timeIn: Date | null
  timeOut: Date | null
  durationMin: number | null
  lateByMin: number | null
  location: string | null
  project: string | null
  status: string
  notes: string | null
  remark?: string | null
  clockInLat?: number | null
  clockInLng?: number | null
  clockOutLat?: number | null
  clockOutLng?: number | null
  breaks?: Array<{ startedAt: Date; endedAt: Date | null }>
  sessions?: Array<{
    id: string
    startedAt: Date
    endedAt: Date | null
    durationMin: number | null
    status: string
    clockInLat: number | null
    clockInLng: number | null
    clockOutLat: number | null
    clockOutLng: number | null
    clockInNotes: string | null
    clockOutNotes: string | null
  }>
}

function attendanceToView(r: PrismaAttendance): AttendanceRecordView {
  const breaks = r.breaks ?? []
  let breakMin = 0
  let currentBreakStartedAt: string | null = null
  for (const b of breaks) {
    if (b.endedAt) {
      breakMin += Math.max(
        0,
        Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 60000),
      )
    } else if (!currentBreakStartedAt) {
      currentBreakStartedAt = b.startedAt.toISOString()
    }
  }
  const sessions: AttendanceSessionView[] = (r.sessions ?? [])
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((s) => ({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      durationMin: s.durationMin,
      status: s.status as AttendanceStatus,
      clockInLat: s.clockInLat,
      clockInLng: s.clockInLng,
      clockOutLat: s.clockOutLat,
      clockOutLng: s.clockOutLng,
      clockInNotes: s.clockInNotes,
      clockOutNotes: s.clockOutNotes,
    }))
  return {
    id: r.id,
    employeeId: r.employeeId,
    name: r.employee?.name ?? null,
    date: r.date.toISOString().slice(0, 10),
    timeIn: r.timeIn?.toISOString() ?? null,
    timeOut: r.timeOut?.toISOString() ?? null,
    onBreak: currentBreakStartedAt !== null,
    currentBreakStartedAt,
    breakMin,
    durationMin: r.durationMin,
    lateByMin: r.lateByMin,
    location: r.location,
    project: r.project,
    status: r.status as AttendanceStatus,
    notes: r.notes,
    remark: r.remark ?? null,
    clockInLat: r.clockInLat ?? null,
    clockInLng: r.clockInLng ?? null,
    clockOutLat: r.clockOutLat ?? null,
    clockOutLng: r.clockOutLng ?? null,
    sessions,
  }
}

const SESSION_SELECT = {
  id: true,
  startedAt: true,
  endedAt: true,
  durationMin: true,
  status: true,
  clockInLat: true,
  clockInLng: true,
  clockOutLat: true,
  clockOutLng: true,
  clockInNotes: true,
  clockOutNotes: true,
} as const

const BREAK_INCLUDE = {
  breaks: { select: { startedAt: true, endedAt: true } },
  sessions: { select: SESSION_SELECT },
} as const

type PrismaApproval = {
  id: string
  kind: string
  status: string
  employeeId: string
  reviewerId: string | null
  date: Date
  eventAt: Date | null
  title: string
  detail: string
  location: string | null
  project: string | null
  otPayoutMethod: string | null
  otStartAt: Date | null
  otEndAt: Date | null
  lateMinutes: number | null
  offsetRef: string | null
  reviewNotes: string | null
  submittedAt: Date
  reviewedAt: Date | null
  chainHistory?: unknown
  employee?: { name: string } | null
}

function parseChainHistory(raw: unknown): ChainHistoryEntry[] | null {
  if (!Array.isArray(raw)) return null
  return raw as ChainHistoryEntry[]
}

function approvalToView(r: PrismaApproval): ApprovalRequestView {
  return {
    id: r.id,
    kind: r.kind as ApprovalKind,
    status: r.status as ApprovalStatus,
    employeeId: r.employeeId,
    employeeName: r.employee?.name ?? r.employeeId,
    reviewerId: r.reviewerId,
    date: r.date.toISOString().slice(0, 10),
    eventAt: r.eventAt?.toISOString() ?? null,
    title: r.title,
    detail: r.detail,
    location: r.location,
    project: r.project,
    otPayoutMethod:
      r.otPayoutMethod === "TIME_BANK" || r.otPayoutMethod === "CASH"
        ? r.otPayoutMethod
        : null,
    otStartAt: r.otStartAt?.toISOString() ?? null,
    otEndAt: r.otEndAt?.toISOString() ?? null,
    lateMinutes: r.lateMinutes,
    // Populated by backfillLateMinutes() from the AttendanceRecord; null here.
    latitude: null,
    longitude: null,
    offsetRef: r.offsetRef,
    reviewNotes: r.reviewNotes,
    submittedAt: r.submittedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    chainHistory: parseChainHistory(r.chainHistory),
    // Populated by attachSelfieRefs() when needed; defaults to null
    // so callers that skip the attach can still consume views safely.
    selfieAttendanceRecordId: null,
    // Defaults — populated by attachChainContext when needed.
    currentStep: r.status === "PENDING" ? 1 : null,
    totalSteps: 1,
    currentStepApproverNames: [],
    currentStepApproverIds: [],
    attachments: [],
  }
}

/**
 * Resolve the current-step approver user-ids for a freshly created
 * PENDING approval request. Returns [] when there's no chain. Used to
 * drive the silent realtime "refresh" so the request shows up live in
 * the right supervisors' approval queues.
 */
async function resolveCurrentApproverIds(
  requestId: string,
  employeeId: string,
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK" | "OT",
  projectId: string | null,
): Promise<string[]> {
  try {
    const ctx = await resolveApprovalContext({
      requestId,
      employeeId,
      kind,
      status: "PENDING",
      reviewerId: null,
      projectId,
    })
    if (ctx.currentStep === null) return []
    return (ctx.chain[ctx.currentStep - 1]?.approvers ?? []).map(
      (a) => a.approverId,
    )
  } catch {
    return []
  }
}

/**
 * Per-row chain resolution. Looks up the project for each approval (via
 * AttendanceRecord on the same employee+date), resolves the chain, and
 * overrides currentStep / totalSteps / currentStepApproverNames on each
 * view. Async + N+1-ish; only call where the UI needs step context.
 */
async function attachChainContext(
  views: ApprovalRequestView[],
): Promise<ApprovalRequestView[]> {
  if (views.length === 0) return views
  const prisma = getClient()
  const dates = Array.from(
    new Set(views.map((v) => `${v.employeeId}|${v.date}`)),
  )
  const dateRows = await prisma.attendanceRecord.findMany({
    where: {
      OR: dates.map((d) => {
        const [employeeId, date] = d.split("|")
        return {
          employeeId,
          date: new Date(`${date}T00:00:00.000Z`),
        }
      }),
    },
    select: { employeeId: true, date: true, projectId: true },
  })
  const projectByKey = new Map<string, string | null>()
  for (const r of dateRows) {
    projectByKey.set(
      `${r.employeeId}|${r.date.toISOString().slice(0, 10)}`,
      r.projectId,
    )
  }
  return Promise.all(
    views.map(async (v) => {
      const projectId = projectByKey.get(`${v.employeeId}|${v.date}`) ?? null
      const ctx = await resolveApprovalContext({
        requestId: v.id,
        employeeId: v.employeeId,
        kind: v.kind,
        status: v.status as "PENDING" | "APPROVED" | "REJECTED",
        reviewerId: v.reviewerId,
        projectId,
      })
      const totalSteps = Math.max(1, ctx.chain.length)
      const currentStep = ctx.currentStep
      const stepEntry =
        currentStep && ctx.chain[currentStep - 1]
          ? ctx.chain[currentStep - 1]
          : null
      const currentStepApproverNames = stepEntry?.approvers.map((a) => a.name) ?? []
      const currentStepApproverIds =
        stepEntry?.approvers.map((a) => a.approverId) ?? []
      return {
        ...v,
        currentStep,
        totalSteps,
        currentStepApproverNames,
        currentStepApproverIds,
      }
    }),
  )
}

/// Re-bucket the employee's attendance for the given day and return the
/// OT minutes that would result if OT were considered approved. Used after
/// an OT request is approved to determine how many minutes to bank when
/// the employee's payout method is TIME_BANK.
async function computeApprovedOtMinutes(
  prisma: ReturnType<typeof getClient>,
  employeeId: string,
  date: Date,
): Promise<number> {
  const day = startOfDay(date)
  const [record, employee] = await Promise.all([
    prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: day } },
      select: {
        date: true,
        durationMin: true,
        projectId: true,
        projectRef: {
          select: { workingHoursStart: true, workingHoursEnd: true, workingDays: true },
        },
      },
    }),
    prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true },
    }),
  ])
  if (!record?.durationMin || record.durationMin <= 0) return 0

  const isPH = record.projectId
    ? Boolean(
        await prisma.projectHoliday.findUnique({
          where: { projectId_date: { projectId: record.projectId, date: day } },
          select: { id: true },
        }),
      )
    : false

  // Daily OT threshold lives on the employee's assigned policy now.
  // Defaults to the legacy 8h fallback when no policy is assigned.
  let otThresholdMin = 8 * 60
  const profile = await prisma.employeeProfile.findFirst({
    where: { userId: employeeId },
    select: { policy: { select: { otDailyThresholdMinutes: true } } },
  })
  if (profile?.policy) {
    otThresholdMin = profile.policy.otDailyThresholdMinutes
  }

  const bucket = bucketRecord({
    durationMin: record.durationMin,
    date: record.date,
    isPublicHoliday: isPH,
    workingDays: parseWorkingDays(record.projectRef?.workingDays ?? null),
    standardDailyMin: standardDailyMinutesFrom(
      record.projectRef?.workingHoursStart ?? null,
      record.projectRef?.workingHoursEnd ?? null,
    ),
    otThresholdMin,
    hasApprovedOT: true,
  })
  return bucket.otMin
}

// ---------------------------------------------------------------------------
// Rollup helper
// ---------------------------------------------------------------------------

/**
 * Reads all AttendanceSessions for a record, then writes the derived
 * rollup fields back to AttendanceRecord so existing payroll / reporting
 * queries that read the record-level fields keep working.
 *
 * Returns the computed values so callers can avoid a second DB round-trip.
 */
async function recomputeRecordRollup(
  recordId: string,
  prisma: ReturnType<typeof getClient>,
): Promise<{
  timeIn: Date | null
  timeOut: Date | null
  durationMin: number | null
  status: AttendanceStatus
}> {
  const sessions = await prisma.attendanceSession.findMany({
    where: { attendanceRecordId: recordId },
    orderBy: { startedAt: "asc" },
    select: { startedAt: true, endedAt: true, durationMin: true, status: true },
  })

  if (sessions.length === 0) {
    return { timeIn: null, timeOut: null, durationMin: null, status: "MISSING" }
  }

  const timeIn = sessions[0].startedAt
  const anyOpen = sessions.some((s) => s.endedAt === null)
  const timeOut = anyOpen
    ? null
    : sessions.reduce<Date | null>(
        (max, s) =>
          s.endedAt && (!max || s.endedAt > max) ? s.endedAt : max,
        null,
      )
  const durationMin = anyOpen
    ? null
    : sessions.reduce((sum, s) => sum + (s.durationMin ?? 0), 0)

  // Status: CLOCKED_OUT when all closed, otherwise use the most recent
  // session's own status (ON_TIME / LATE).
  let status: AttendanceStatus = "MISSING"
  if (!anyOpen) {
    status = "CLOCKED_OUT"
  } else {
    const latestSession = sessions[sessions.length - 1]
    status = latestSession.status as AttendanceStatus
  }

  await prisma.attendanceRecord.update({
    where: { id: recordId },
    data: { timeIn, timeOut, durationMin, status },
  })

  return { timeIn, timeOut, durationMin, status }
}

/**
 * Where-clauses backing the status pills on the admin attendance History
 * tab.
 *
 * These deliberately do NOT filter on `AttendanceRecord.status`. That
 * column is a roll-up which `recomputeRecordRollup` (above) overwrites
 * with `CLOCKED_OUT` the moment every session for the day is closed — so
 * by the end of any given day it no longer says whether the employee was
 * on time or late. The punctuality survives on each `AttendanceSession`,
 * so the filters read through the relation.
 *
 * A day counts as LATE if *any* session that day started late, which
 * matches how the row badge is rendered in the history table.
 */
const HISTORY_STATUS_FILTERS: Record<string, Record<string, unknown>> = {
  ON_TIME: {
    status: { not: "ON_LEAVE" },
    sessions: { some: {} },
    NOT: { sessions: { some: { status: "LATE" } } },
  },
  LATE: {
    status: { not: "ON_LEAVE" },
    sessions: { some: { status: "LATE" } },
  },
  // No sessions at all — `recomputeRecordRollup` leaves these MISSING.
  MISSING: { status: "MISSING" },
  ON_LEAVE: { status: "ON_LEAVE" },
}

/**
 * Where-clause for the history tab's "OT" pill: days the employee has an
 * overtime request on. Approved *and* pending both count — the pill is for
 * finding OT, and hiding the unreviewed half would make it useless for
 * chasing approvals.
 *
 * OT lives on `ApprovalRequest`, which has no relation to
 * `AttendanceRecord` (both hang off `User`), and Prisma can't correlate a
 * record's own `date` inside a relation filter. So this resolves the
 * matching (employee, day) pairs up front and groups them by day, giving
 * at most one OR term per day in the range rather than one per pair.
 *
 * Returns null when nothing matches, which the caller treats as "this pill
 * contributed no rows" rather than "no filter".
 */
async function buildOtDayClause(
  prisma: ReturnType<typeof getClient>,
  from: Date,
  to: Date,
  scope: { employeeId?: unknown; employee?: unknown },
): Promise<Record<string, unknown> | null> {
  const rows = await prisma.approvalRequest.findMany({
    where: {
      kind: "OT",
      status: { in: ["APPROVED", "PENDING"] },
      date: { gte: from, lte: to },
      ...(scope.employeeId ? { employeeId: scope.employeeId } : {}),
      ...(scope.employee ? { employee: scope.employee } : {}),
    },
    select: { employeeId: true, date: true },
  })
  if (rows.length === 0) return null

  // Normalise to UTC midnight — `AttendanceRecord.date` is always stored
  // that way, but legacy auto-created OT rows may carry a wall time.
  const byDay = new Map<number, Set<string>>()
  for (const row of rows) {
    const day = startOfDay(row.date).getTime()
    const ids = byDay.get(day) ?? new Set<string>()
    ids.add(row.employeeId)
    byDay.set(day, ids)
  }

  return {
    OR: Array.from(byDay, ([day, ids]) => ({
      date: new Date(day),
      employeeId: { in: Array.from(ids) },
    })),
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

const SYSTEM_DEFAULT_HOURS = { start: "09:00", end: "18:00" } as const

export const attendanceRepository = {
  // ── User / org lookups (used by the employee-attendance service to resolve
  // an employee's org + geofence context without bypassing the repo layer).

  /**
   * Find any PENDING attendance approval (CLOCK_IN/CLOCK_OUT/BREAK) for
   * this employee on the given UTC day. Used by the employee-attendance
   * service to block the NEXT clock event when a prior one is still
   * waiting on a supervisor — without this, employees can rack up a
   * chain of pending events that pile up in the supervisor's queue.
   *
   * Returns the matched approval (id + kind) or null when nothing is
   * pending. OT approvals are deliberately excluded — they're a
   * side-effect of clock-out, not an event the employee chose to do,
   * so they shouldn't block subsequent activity.
   */
  async findPendingClockOrBreakApprovalForDay(
    employeeId: string,
    day: Date,
  ): Promise<{ id: string; kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK" } | null> {
    const prisma = getClient()
    if (!prisma) return null
    const tz = await this.getEmployeeTimezone(employeeId)
    const row = await prisma.approvalRequest.findFirst({
      where: {
        employeeId,
        date: startOfLocalDay(day, tz),
        status: "PENDING",
        kind: { in: ["CLOCK_IN", "CLOCK_OUT", "BREAK"] },
      },
      orderBy: { eventAt: "desc" },
      select: { id: true, kind: true },
    })
    if (!row) return null
    return { id: row.id, kind: row.kind as "CLOCK_IN" | "CLOCK_OUT" | "BREAK" }
  },

  /**
   * Sum worked minutes for an employee across a period, bucketed by
   * day type (working-day normal vs OT past threshold vs rest-day vs
   * public-holiday). Approval status is NOT consulted — over-threshold
   * time always lands in `otMin` regardless of whether the OT request
   * has been approved yet. Mirrors the always-split semantics in
   * `bucketRecord` and powers the payroll run table's HRS column:
   * HRS = `normalMin / 60`, so OT never inflates normal worked hours.
   *
   * Pair with `getApprovedOtMinutesForPeriod` when you want the
   * approval-aware view (e.g. for OT pay): that one filters by
   * APPROVED requests; this one tells you what was actually clocked.
   */
  async getWorkedHoursBucketsForPeriod(args: {
    employeeId: string
    from: Date
    to: Date
  }): Promise<{
    normalMin: number
    otMin: number
    restMin: number
    publicMin: number
  }> {
    const prisma = getClient()
    if (!prisma) return { normalMin: 0, otMin: 0, restMin: 0, publicMin: 0 }

    const [records, profile] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: {
          employeeId: args.employeeId,
          date: { gte: args.from, lte: args.to },
          durationMin: { not: null, gt: 0 },
        },
        select: {
          date: true,
          durationMin: true,
          projectId: true,
          projectRef: {
            select: {
              workingHoursStart: true,
              workingHoursEnd: true,
              workingDays: true,
              lunchBreakMinutes: true,
            },
          },
        },
      }),
      prisma.employeeProfile.findFirst({
        where: { userId: args.employeeId },
        select: {
          policy: { select: { otDailyThresholdMinutes: true } },
        },
      }),
    ])

    if (records.length === 0) {
      return { normalMin: 0, otMin: 0, restMin: 0, publicMin: 0 }
    }

    const projectIds = Array.from(
      new Set(
        records
          .map((r) => r.projectId)
          .filter((id): id is string => Boolean(id)),
      ),
    )
    const holidayKeys = new Set<string>()
    if (projectIds.length > 0) {
      const holidays = await prisma.projectHoliday.findMany({
        where: {
          projectId: { in: projectIds },
          date: { gte: args.from, lte: args.to },
        },
        select: { projectId: true, date: true },
      })
      for (const h of holidays) {
        holidayKeys.add(`${h.projectId}:${h.date.toISOString().slice(0, 10)}`)
      }
    }

    const otThresholdMin = profile?.policy?.otDailyThresholdMinutes ?? 480

    let normalMin = 0
    let otMin = 0
    let restMin = 0
    let publicMin = 0
    for (const rec of records) {
      const isPH = rec.projectId
        ? holidayKeys.has(
            `${rec.projectId}:${rec.date.toISOString().slice(0, 10)}`,
          )
        : false
      const workingDays = parseWorkingDays(rec.projectRef?.workingDays ?? null)
      const standardDailyMin = standardDailyMinutesFrom(
        rec.projectRef?.workingHoursStart ?? null,
        rec.projectRef?.workingHoursEnd ?? null,
        rec.projectRef?.lunchBreakMinutes ?? null,
      )
      const bucket = bucketRecord({
        durationMin: rec.durationMin ?? 0,
        date: rec.date,
        isPublicHoliday: isPH,
        workingDays,
        standardDailyMin,
        otThresholdMin,
        hasApprovedOT: true, // unused after always-split change
      })
      normalMin += bucket.normalMin
      otMin += bucket.otMin
      restMin += bucket.restDayMin
      publicMin += bucket.publicHolidayMin
    }

    return { normalMin, otMin, restMin, publicMin }
  },

  /**
   * Sum approved OT minutes for an employee across a period, broken down
   * by day-type bucket so payroll can apply the right OT rate to each:
   *   - `normalOtMin` — minutes past the daily threshold on a working day.
   *   - `restMin`     — every minute worked on a rest day (non-working
   *                     weekday in the project's working-days set).
   *   - `publicMin`   — every minute worked on a project public holiday.
   *
   * **Only counts days that have an APPROVED OT `ApprovalRequest`** — pending
   * or rejected requests are excluded. This is the source of truth payroll
   * uses; the legacy admin-typed `otNormalHours` adjustment is no longer
   * honoured (see payroll-run.service.ts).
   */
  async getApprovedOtMinutesForPeriod(args: {
    employeeId: string
    /// Inclusive start of period.
    from: Date
    /// Exclusive end of period.
    to: Date
  }): Promise<{ normalOtMin: number; restMin: number; publicMin: number }> {
    const prisma = getClient()
    if (!prisma) return { normalOtMin: 0, restMin: 0, publicMin: 0 }

    // OT is now submission-driven: minutes come from the employee's
    // submitted time range (otStartAt → otEndAt), not from worked duration.
    const approvedOt = await prisma.approvalRequest.findMany({
      where: {
        employeeId: args.employeeId,
        kind: "OT",
        status: "APPROVED",
        date: { gte: args.from, lte: args.to },
        otStartAt: { not: null },
        otEndAt: { not: null },
      },
      select: {
        date: true,
        otStartAt: true,
        otEndAt: true,
        otProjectId: true,
      },
    })

    if (approvedOt.length === 0) {
      return { normalOtMin: 0, restMin: 0, publicMin: 0 }
    }

    // Public-holiday lookup scoped to the projects referenced on the requests.
    const projectIds = Array.from(
      new Set(approvedOt.map((r) => r.otProjectId).filter((id): id is string => Boolean(id))),
    )
    const holidayKeys = new Set<string>()
    if (projectIds.length > 0) {
      const holidays = await prisma.projectHoliday.findMany({
        where: {
          projectId: { in: projectIds },
          date: { gte: args.from, lte: args.to },
        },
        select: { projectId: true, date: true },
      })
      for (const h of holidays) {
        holidayKeys.add(`${h.projectId}:${h.date.toISOString().slice(0, 10)}`)
      }
    }

    // Fetch working-days config for referenced projects so rest-day OT
    // can be bucketed correctly.
    const projects =
      projectIds.length > 0
        ? await prisma.xeroProject.findMany({
            where: { id: { in: projectIds } },
            select: { id: true, workingDays: true },
          })
        : []
    const workingDaysByProject = new Map(
      projects.map((p) => [p.id, parseWorkingDays(p.workingDays ?? null)]),
    )

    let normalOtMin = 0
    let restMin = 0
    let publicMin = 0
    for (const req of approvedOt) {
      if (!req.otStartAt || !req.otEndAt) continue
      const submittedMin = Math.round(
        (req.otEndAt.getTime() - req.otStartAt.getTime()) / 60_000,
      )
      if (submittedMin <= 0) continue

      const dateKey = req.date.toISOString().slice(0, 10)
      const isPH = req.otProjectId
        ? holidayKeys.has(`${req.otProjectId}:${dateKey}`)
        : false

      if (isPH) {
        publicMin += submittedMin
      } else {
        const workingDays = req.otProjectId
          ? (workingDaysByProject.get(req.otProjectId) ?? parseWorkingDays(null))
          : parseWorkingDays(null)
        if (workingDays.has(isoWeekday(req.date))) {
          normalOtMin += submittedMin
        } else {
          restMin += submittedMin
        }
      }
    }

    return { normalOtMin, restMin, publicMin }
  },

  async getOrganizationIdForUser(userId: string): Promise<string | null> {
    const prisma = getClient()
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    })
    return user?.organizationId ?? null
  },

  /**
   * The employee's organisation timezone in a single query (user →
   * organization.timezone), falling back to `DEFAULT_TIMEZONE`. Used by the
   * day-bucketing reads so "today" is the employee's *local* day, not the
   * UTC day — see `startOfLocalDay`.
   */
  async getEmployeeTimezone(employeeId: string): Promise<string> {
    const prisma = getClient()
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organization: { select: { timezone: true } } },
    })
    return user?.organization?.timezone || DEFAULT_TIMEZONE
  },

  /**
   * Batch variant of `getOrganizationIdForUser` — looks up the
   * organisation for many users in a single query. Returns a map of
   * `userId → organizationId`. Users with no org (or missing rows) are
   * omitted from the map rather than mapped to null, so callers can
   * iterate `.get(userId)` and treat undefined as "no org / skip".
   */
  async getOrganizationIdsForUsers(
    userIds: string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map()
    const prisma = getClient()
    const rows = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, organizationId: true },
    })
    const map = new Map<string, string>()
    for (const row of rows) {
      if (row.organizationId) map.set(row.id, row.organizationId)
    }
    return map
  },

  /**
   * Org-scoped storage summary for the admin attendance "Selfie storage"
   * card: total selfies on disk in Xero, oldest, newest. Returns zeroes
   * when nothing has been uploaded yet.
   */
  async getSelfieStorageStats(organizationId: string): Promise<{
    total: number
    oldest: Date | null
    newest: Date | null
  }> {
    const prisma = getClient()
    const [total, oldest, newest] = await Promise.all([
      prisma.attendanceRecord.count({
        where: {
          xeroSelfieFileId: { not: null },
          employee: { organizationId },
        },
      }),
      prisma.attendanceRecord.findFirst({
        where: {
          xeroSelfieFileId: { not: null },
          employee: { organizationId },
        },
        orderBy: { selfieUploadedAt: "asc" },
        select: { selfieUploadedAt: true },
      }),
      prisma.attendanceRecord.findFirst({
        where: {
          xeroSelfieFileId: { not: null },
          employee: { organizationId },
        },
        orderBy: { selfieUploadedAt: "desc" },
        select: { selfieUploadedAt: true },
      }),
    ])
    return {
      total,
      oldest: oldest?.selfieUploadedAt ?? null,
      newest: newest?.selfieUploadedAt ?? null,
    }
  },

  /**
   * List attendance records inside [from, to] (inclusive) that have a
   * selfie file id, scoped to the given org. Used by the bulk-delete
   * action to enumerate what it has to clean up before hitting Xero
   * for each row. Capped to `limit` (default 500) to keep one batch
   * predictable.
   */
  async listStaleSelfies(input: {
    organizationId: string
    from: Date
    to: Date
    limit?: number
  }): Promise<
    Array<{
      id: string
      xeroSelfieFileId: string
      employeeOrgId: string | null
    }>
  > {
    const prisma = getClient()
    const rows = await prisma.attendanceRecord.findMany({
      where: {
        xeroSelfieFileId: { not: null },
        selfieUploadedAt: { gte: input.from, lte: input.to },
        employee: { organizationId: input.organizationId },
      },
      select: {
        id: true,
        xeroSelfieFileId: true,
        employee: { select: { organizationId: true } },
      },
      take: input.limit ?? 500,
    })
    return rows
      .filter((row): row is typeof row & { xeroSelfieFileId: string } =>
        row.xeroSelfieFileId !== null,
      )
      .map((row) => ({
        id: row.id,
        xeroSelfieFileId: row.xeroSelfieFileId,
        employeeOrgId: row.employee.organizationId ?? null,
      }))
  },

  /**
   * Clear the selfie columns on an AttendanceRecord. Called by the
   * bulk-delete action after the Xero DELETE succeeds (or is skipped).
   */
  async clearSelfie(recordId: string): Promise<void> {
    const prisma = getClient()
    await prisma.attendanceRecord.update({
      where: { id: recordId },
      data: { xeroSelfieFileId: null, selfieUploadedAt: null },
    })
  },

  /**
   * Minimum data needed by the selfie-proxy route to authorise + locate
   * a clock-in selfie:
   *   - `employeeId` for owner / supervisor-in-chain checks
   *   - `employeeOrgId` for admin-in-same-org check + Xero connection
   *     lookup
   *   - `xeroSelfieFileId` to fetch the actual binary
   * Returns `null` if the record doesn't exist or has no selfie
   * attached.
   */
  async getSelfieAccessRecord(recordId: string, phase: "clock-in" | "clock-out" = "clock-in"): Promise<{
    employeeId: string
    employeeOrgId: string | null
    xeroSelfieFileId: string
  } | null> {
    const prisma = getClient()

    // For CLOCK_IN with multiple sessions on the same day, backfillLateMinutes
    // now passes an AttendanceSession.id so each session shows its own selfie.
    // Try session lookup first; fall back to the legacy AttendanceRecord path.
    if (phase === "clock-in") {
      const session = await prisma.attendanceSession.findUnique({
        where: { id: recordId },
        select: {
          xeroSelfieFileId: true,
          attendanceRecord: {
            select: {
              employeeId: true,
              employee: { select: { organizationId: true } },
            },
          },
        },
      })
      if (session) {
        if (!session.xeroSelfieFileId) return null
        return {
          employeeId: session.attendanceRecord.employeeId,
          employeeOrgId: session.attendanceRecord.employee.organizationId ?? null,
          xeroSelfieFileId: session.xeroSelfieFileId,
        }
      }
      // Not a session ID — fall through to record lookup below.
    }

    const row = await prisma.attendanceRecord.findUnique({
      where: { id: recordId },
      select: {
        employeeId: true,
        xeroSelfieFileId: true,
        clockOutXeroSelfieFileId: true,
        employee: { select: { organizationId: true } },
      },
    })
    if (!row) return null
    const fileId =
      phase === "clock-out" ? row.clockOutXeroSelfieFileId : row.xeroSelfieFileId
    if (!fileId) return null
    return {
      employeeId: row.employeeId,
      employeeOrgId: row.employee.organizationId ?? null,
      xeroSelfieFileId: fileId,
    }
  },

  /**
   * OT-time-bank and policy hints needed by the employee attendance
   * dashboard. Returns `null` if the user has no profile (e.g. an admin
   * with no employee record). Pages call this through
   * `employeeAttendanceService.getProfileExtras` rather than touching
   * Prisma directly.
   */
  async getEmployeeOtExtras(userId: string): Promise<{
    otTimeBalanceMin: number
    otEnabled: boolean
    otMethod: "CASH" | "TIME_BANK"
    requireSelfie: boolean
  } | null> {
    const prisma = getClient()
    const profile = await prisma.employeeProfile.findFirst({
      where: { userId },
      select: {
        otTimeBalanceMin: true,
        policy: {
          select: { otEnabled: true, otMethod: true, requireSelfie: true },
        },
      },
    })
    if (!profile) return null
    return {
      otTimeBalanceMin: profile.otTimeBalanceMin,
      otEnabled: profile.policy?.otEnabled ?? false,
      otMethod: (profile.policy?.otMethod ?? "CASH") as "CASH" | "TIME_BANK",
      requireSelfie: profile.policy?.requireSelfie ?? false,
    }
  },

  async getGeofenceRadiusForOrganization(orgId: string | null): Promise<number | null> {
    if (!orgId) return null
    const prisma = getClient()
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { geofenceRadiusMeters: true },
    })
    return org?.geofenceRadiusMeters ?? null
  },

  async getProjectGeoById(projectId: string): Promise<{
    name: string
    latitude: number | null
    longitude: number | null
    geoLocations: Array<{
      id: string
      label: string
      latitude: number
      longitude: number
    }>
  } | null> {
    const prisma = getClient()
    const project = await prisma.xeroProject.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        latitude: true,
        longitude: true,
        geoLocations: {
          select: { id: true, label: true, latitude: true, longitude: true },
          orderBy: { createdAt: "asc" },
        },
      },
    })
    return project ?? null
  },

  /// Fetch the project's IP allowlist for the clock-in IP-whitelist check.
  /// One-release shim: returns the legacy comma-separated string shape so
  /// existing callers (`lib/ip-whitelist.parseAllowlist`) don't have to
  /// change yet. Prefers the new JSON `allowedIpsList` column; falls back
  /// to the legacy `allowedIps` string when the JSON column is empty.
  /// Returns null when neither column has anything.
  async getProjectAllowedIps(projectId: string): Promise<string | null> {
    const prisma = getClient()
    const row = await prisma.xeroProject.findUnique({
      where: { id: projectId },
      select: { allowedIps: true, allowedIpsList: true },
    })
    if (!row) return null
    const list = row.allowedIpsList
    if (Array.isArray(list) && list.length > 0) {
      const cidrs: string[] = []
      for (const entry of list) {
        if (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as { cidr?: unknown }).cidr === "string"
        ) {
          const cidr = (entry as { cidr: string }).cidr.trim()
          if (cidr.length > 0) cidrs.push(cidr)
        }
      }
      if (cidrs.length > 0) return cidrs.join(", ")
    }
    const legacy = row.allowedIps
    if (typeof legacy === "string" && legacy.trim().length > 0) {
      return legacy
    }
    return null
  },

  async getTodayProjectId(employeeId: string): Promise<string | null> {
    const prisma = getClient()
    const tz = await this.getEmployeeTimezone(employeeId)
    const today = startOfLocalDay(new Date(), tz)
    const record = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: today } },
      select: { projectId: true },
    })
    return record?.projectId ?? null
  },

  /**
   * Returns the employee's project assignments + legacy project string in
   * one shot. Used by `getAvailableProjects` in the service to decide whether
   * to use the assignment list or fall back to legacy. Replaces a 25-line
   * `prisma.user.findUnique` literal that the service used to do directly.
   */
  async getEmployeeProjectAssignments(
    employeeId: string,
    organizationId?: string,
  ): Promise<{
    organizationId: string | null
    assignments: Array<{
      id: string
      name: string
      status: string | null
      latitude: number | null
      longitude: number | null
      workingDays: string | null
      geoLocations: Array<{
        id: string
        label: string
        latitude: number
        longitude: number
      }>
    }>
  } | null> {
    const prisma = getClient()
    // Multi-org: filter the employeeProfiles include by
    // `organizationId` so a user with profiles at 2+ companies reads
    // the CURRENT company's project assignments (not the first-
    // created one). The returned `organizationId` is the active org
    // when provided, so downstream code (empty-list short-circuit,
    // geofence lookups) uses the right org too.
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: {
        organizationId: true,
        employeeProfiles: {
          where: organizationId ? { organizationId } : undefined,
          select: {
            projectAssignments: {
              select: {
                project: {
                  select: {
                    id: true,
                    name: true,
                    status: true,
                    latitude: true,
                    longitude: true,
                    workingDays: true,
                    geoLocations: {
                      select: {
                        id: true,
                        label: true,
                        latitude: true,
                        longitude: true,
                      },
                      orderBy: { createdAt: "asc" },
                    },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
          take: 1,
        },
      },
    })
    if (!user) return null
    return {
      organizationId: organizationId ?? user.organizationId ?? null,
      assignments: (user.employeeProfiles[0]?.projectAssignments ?? []).map(
        (assignment) => assignment.project
      ),
    }
  },

  // ── Working hours ──────────────────────────────────────────────────────

  async getWorkingHours(
    orgId: string | null,
    projectId?: string | null,
  ): Promise<{ start: string; end: string }> {
    if (!orgId) return { ...SYSTEM_DEFAULT_HOURS }
    const prisma = getClient()

    if (projectId) {
      const project = await prisma.xeroProject.findFirst({
        where: { id: projectId, organizationId: orgId },
        select: { workingHoursStart: true, workingHoursEnd: true },
      })
      if (project?.workingHoursStart && project?.workingHoursEnd) {
        return { start: project.workingHoursStart, end: project.workingHoursEnd }
      }
    }

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { workingHoursStart: true, workingHoursEnd: true },
    })
    if (!org) return { ...SYSTEM_DEFAULT_HOURS }
    return { start: org.workingHoursStart, end: org.workingHoursEnd }
  },

  async getOrgTimezone(orgId: string | null): Promise<string> {
    if (!orgId) return DEFAULT_TIMEZONE
    const prisma = getClient()
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    })
    return org?.timezone || DEFAULT_TIMEZONE
  },

  async setWorkingHours(orgId: string, start: string, end: string): Promise<void> {
    const prisma = getClient()
    await prisma.organization.update({
      where: { id: orgId },
      data: { workingHoursStart: start, workingHoursEnd: end },
    })
  },

  async setTimezone(orgId: string, timezone: string): Promise<void> {
    const prisma = getClient()
    await prisma.organization.update({
      where: { id: orgId },
      data: { timezone },
    })
  },

  // ── Employee dashboard ────────────────────────────────────────────────

  async findOpenSessionAcrossDays(
    employeeId: string,
  ): Promise<{
    sessionId: string
    startedAt: string
    date: string
    projectName: string | null
  } | null> {
    const prisma = getClient()
    const tz = await this.getEmployeeTimezone(employeeId)
    const today = startOfLocalDay(new Date(), tz)
    // Query from the record side to avoid Prisma nested-select type inference
    // issues that cause `session.record` to be typed as `never`.
    const record = await prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        date: { lt: today },
        sessions: { some: { endedAt: null } },
      },
      select: {
        date: true,
        project: true,
        sessions: {
          where: { endedAt: null },
          select: { id: true, startedAt: true },
          orderBy: { startedAt: "asc" },
          take: 1,
        },
      },
      orderBy: { date: "asc" },
    })
    if (!record || record.sessions.length === 0) return null
    const session = record.sessions[0]
    return {
      sessionId: session.id,
      startedAt: session.startedAt.toISOString(),
      date: record.date.toISOString().slice(0, 10),
      projectName: record.project,
    }
  },

  async getTodayAttendance(employeeId: string): Promise<AttendanceRecordView | null> {
    const prisma = getClient()
    const tz = await this.getEmployeeTimezone(employeeId)
    const today = startOfLocalDay(new Date(), tz)
    const r = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: today } },
      include: BREAK_INCLUDE,
    })
    return r ? attendanceToView(r) : null
  },

  async getWeekAttendance(employeeId: string): Promise<AttendanceRecordView[]> {
    const prisma = getClient()
    const tz = await this.getEmployeeTimezone(employeeId)
    // Base the week off *local* today (UTC-midnight of the local calendar
    // date), so getUTCDay() reads the local day-of-week and an early-morning
    // shift lands in the correct week rather than the previous one.
    const monday = startOfLocalDay(new Date(), tz)
    const dayOfWeek = monday.getUTCDay() // 0 = Sun
    monday.setUTCDate(monday.getUTCDate() - ((dayOfWeek + 6) % 7))
    const records = await prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: monday } },
      orderBy: { date: "desc" },
      include: BREAK_INCLUDE,
    })
    return records.map(attendanceToView)
  },

  async getTodayEvents(employeeId: string): Promise<ClockEventLite[]> {
    const prisma = getClient()
    const tz = await this.getEmployeeTimezone(employeeId)
    const today = startOfLocalDay(new Date(), tz)
    const events = await prisma.approvalRequest.findMany({
      where: {
        employeeId,
        date: today,
        kind: { in: ["CLOCK_IN", "CLOCK_OUT", "BREAK"] },
      },
      orderBy: { eventAt: "asc" },
      select: {
        id: true,
        kind: true,
        status: true,
        eventAt: true,
        title: true,
        reviewNotes: true,
        reviewer: { select: { name: true } },
      },
    })
    return events.map((e) => {
      const kind = e.kind as "CLOCK_IN" | "CLOCK_OUT" | "BREAK"
      let breakSubtype: "start" | "end" | null = null
      if (kind === "BREAK") {
        const title = e.title.toLowerCase()
        breakSubtype = title.startsWith("break end")
          ? "end"
          : title.startsWith("break start")
            ? "start"
            : null
      }
      return {
        id: e.id,
        kind,
        status: e.status as ApprovalStatus,
        eventAt: (e.eventAt ?? new Date()).toISOString(),
        breakSubtype,
        reviewNotes: e.reviewNotes,
        reviewerName: e.reviewer?.name ?? null,
      }
    })
  },

  async getRejectedClockEvents(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{
    date: string
    kind: "CLOCK_IN" | "CLOCK_OUT"
    eventAt: string
    reviewNotes: string | null
    reviewerName: string | null
  }>> {
    const prisma = getClient()
    const rows = await prisma.approvalRequest.findMany({
      where: {
        employeeId,
        status: "REJECTED",
        kind: { in: ["CLOCK_IN", "CLOCK_OUT"] },
        date: { gte: startOfDay(from), lte: endOfDay(to) },
      },
      orderBy: { date: "desc" },
      select: {
        date: true,
        kind: true,
        eventAt: true,
        reviewNotes: true,
        reviewer: { select: { name: true } },
      },
    })
    return rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      kind: r.kind as "CLOCK_IN" | "CLOCK_OUT",
      eventAt: (r.eventAt ?? r.date).toISOString(),
      reviewNotes: r.reviewNotes,
      reviewerName: r.reviewer?.name ?? null,
    }))
  },

  async getEmployeeOTApprovals(employeeId: string): Promise<ApprovalRequestView[]> {
    const prisma = getClient()
    const records = await prisma.approvalRequest.findMany({
      where: { employeeId, kind: "OT" },
      orderBy: { submittedAt: "desc" },
      include: {
        employee: { select: { name: true } },
        otAttachments: { orderBy: { createdAt: "asc" } },
      },
      take: 50,
    })
    return records.map((r) => ({
      ...approvalToView(r),
      attachments: (r.otAttachments ?? []).map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileUrl: a.fileUrl,
        mimeType: a.mimeType,
        uploadedAt: a.createdAt.toISOString(),
        kind: a.kind as "JUSTIFICATION" | "EVIDENCE",
      })),
    }))
  },

  async addOtAttachment(
    approvalRequestId: string,
    data: { fileName: string; fileUrl: string; mimeType: string; sizeBytes: number; kind?: "JUSTIFICATION" | "EVIDENCE" },
  ): Promise<string> {
    const prisma = getClient()
    const row = await prisma.otAttachment.create({
      data: { approvalRequestId, ...data },
      select: { id: true },
    })
    return row.id
  },

  async deleteOtAttachment(
    attachmentId: string,
    employeeId: string,
  ): Promise<string | null> {
    const prisma = getClient()
    const row = await prisma.otAttachment.findFirst({
      where: { id: attachmentId, approvalRequest: { employeeId } },
      select: { id: true, fileUrl: true },
    })
    if (!row) return null
    await prisma.otAttachment.delete({ where: { id: attachmentId } })
    return row.fileUrl
  },

  async getAttendanceHistory(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<AttendanceRecordView[]> {
    const prisma = getClient()
    const records = await prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: startOfDay(from), lte: endOfDay(to) } },
      orderBy: { date: "desc" },
      include: BREAK_INCLUDE,
    })
    return records.map(attendanceToView)
  },

  /// Per-day project NAME the employee actually clocked into, keyed by
  /// `yyyy-mm-dd` (same key as `getAttendanceHistory`). Resolves the
  /// `projectId` FK's name (preferred), falling back to the legacy
  /// free-string `project`. Used by the attendance-report Project column.
  async getAttendanceProjectsForRange(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<Map<string, string>> {
    const prisma = getClient()
    const rows = await prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: startOfDay(from), lte: endOfDay(to) } },
      select: {
        date: true,
        project: true,
        projectRef: { select: { name: true } },
      },
    })
    const map = new Map<string, string>()
    for (const r of rows) {
      const name = r.projectRef?.name ?? r.project ?? null
      if (name) map.set(r.date.toISOString().slice(0, 10), name)
    }
    return map
  },

  /**
   * Flat clock-in/out rows for many employees over a range — the day-by-
   * day attendance export's source. Deliberately minimal (no sessions or
   * breaks) because the export only prints the first in and last out;
   * pulling `BREAK_INCLUDE` for 200 employees × 30 days would be an
   * order of magnitude more rows for data nothing renders.
   */
  async getAttendanceForEmployeesInRange(
    employeeIds: string[],
    from: Date,
    to: Date,
  ): Promise<
    Array<{
      employeeId: string
      date: string
      timeIn: string | null
      timeOut: string | null
      status: AttendanceStatus
    }>
  > {
    if (employeeIds.length === 0) return []
    const prisma = getClient()
    const rows = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { gte: startOfDay(from), lte: endOfDay(to) },
      },
      select: {
        employeeId: true,
        date: true,
        timeIn: true,
        timeOut: true,
        status: true,
      },
    })
    return rows.map((r) => ({
      employeeId: r.employeeId,
      date: r.date.toISOString().slice(0, 10),
      timeIn: r.timeIn?.toISOString() ?? null,
      timeOut: r.timeOut?.toISOString() ?? null,
      status: r.status as AttendanceStatus,
    }))
  },

  // ── Clock actions (employee) ──────────────────────────────────────────

  async clockIn(
    employeeId: string,
    projectName: string,
    location?: string,
    projectId?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
    /// IP-whitelist audit fields, only set when the employee's policy
    /// has `requireIpWhitelist=true` AND a client IP was captured from
    /// the request. `allowed=null` when the check was skipped (project
    /// has no allowedIps), `false` when the IP mismatched AND the
    /// employee provided a remark override.
    ip?: { address: string; allowed: boolean | null },
  ): Promise<{
    recordId: string
    sessionId: string
    approvalId: string
    /// Current-step approver user-ids for the PENDING request just
    /// created (empty when auto-approved). The service publishes a
    /// silent realtime "refresh" to them so the request appears live in
    /// their approval queue — without a per-event bell notification
    /// (the digest cron owns batched bell reminders).
    pendingApproverIds: string[]
  }> {
    const prisma = getClient()
    const now = new Date()

    const employee = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true, role: true },
    })
    const orgId = employee?.organizationId ?? null
    const [hours, tz] = await Promise.all([
      this.getWorkingHours(orgId, projectId ?? null),
      this.getOrgTimezone(orgId),
    ])
    // Local calendar day (org timezone), not UTC — so an early-morning
    // clock-in files under today rather than yesterday. See startOfLocalDay.
    const today = startOfLocalDay(now, tz)
    const expected = expectedTimeOnLocalDay(now, hours.start, tz)
    const diff = diffMinutes(expected, now)
    const lateMin = diff > 0 ? diff : 0
    const earlyMin = diff < 0 ? -diff : 0
    const status: AttendanceStatus = lateMin > 0 ? "LATE" : "ON_TIME"

    // Guard: reject if a previous-day session is still open (employee
    // forgot to clock out). Must call clockOut on that session first.
    const orphan = await this.findOpenSessionAcrossDays(employeeId)
    if (orphan) {
      throw new Error("You still have an open session — please clock out before clocking in again.")
    }

    // Find or create today's roll-up record, then check for an open session.
    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: today } },
      update: {},
      create: {
        employeeId,
        date: today,
        status: "MISSING",
      },
      select: {
        id: true,
        sessions: {
          where: { endedAt: null },
          select: { id: true },
        },
      },
    })

    if (record.sessions.length > 0) {
      throw new Error("You still have an open session — please clock out before clocking in again.")
    }

    // Create the new session for this clock-in.
    const session = await prisma.attendanceSession.create({
      data: {
        attendanceRecordId: record.id,
        startedAt: now,
        status,
        project: projectName,
        projectId: projectId ?? null,
        clockInNotes: notes ?? null,
        ...(geo
          ? {
              clockInLat: geo.lat,
              clockInLng: geo.lng,
              clockInDistanceMeters: geo.distanceMeters,
            }
          : {}),
        ...(ip
          ? {
              clockInIpAddress: ip.address,
              clockInIpAllowed: ip.allowed,
            }
          : {}),
      },
      select: { id: true },
    })

    // Recompute and write rollup fields.
    await recomputeRecordRollup(record.id, prisma)

    // Also update project / location on the record (informational rollup).
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        project: projectName,
        projectId: projectId ?? null,
        location: location ?? null,
        lateByMin: lateMin || null,
        ...(notes ? { notes: `CLOCK_IN: ${notes}` } : {}),
        ...(geo
          ? {
              clockInLat: geo.lat,
              clockInLng: geo.lng,
              clockInDistanceMeters: geo.distanceMeters,
            }
          : {}),
      },
    })

    const autoApprove = await shouldAutoApprove({
      employeeId,
      role: employee?.role,
      projectId: projectId ?? null,
      kind: "CLOCK_IN",
    })
    const timingNote =
      lateMin > 0
        ? ` • ${lateMin}m late`
        : earlyMin > 0
          ? ` • ${earlyMin}m early`
          : ""
    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "CLOCK_IN",
        status: autoApprove ? "APPROVED" : "PENDING",
        date: today,
        eventAt: now,
        title: `Clock-in ${localHm(now, tz)}${timingNote}`,
        detail: buildApprovalDetail(
          `${projectName}${location ? ` • ${location}` : ""}${timingNote}`,
          notes,
        ),
        location: location ?? null,
        project: projectName,
        lateMinutes: lateMin > 0 ? lateMin : null,
        ...(autoApprove
          ? {
              reviewerId: employeeId,
              reviewedAt: now,
              reviewNotes: "Auto-approved (supervisor self-attendance)",
            }
          : {}),
      },
    })

    // Link the approval to this session.
    await prisma.attendanceSession.update({
      where: { id: session.id },
      data: { clockInApprovalRequestId: approval.id },
    })

    const pendingApproverIds = autoApprove
      ? []
      : await resolveCurrentApproverIds(
          approval.id,
          employeeId,
          "CLOCK_IN",
          projectId ?? null,
        )

    return { recordId: record.id, sessionId: session.id, approvalId: approval.id, pendingApproverIds }
  },

  async clockOut(
    employeeId: string,
    location?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
    orphanedSessionId?: string,
  ): Promise<{
    recordId: string
    approvalId: string
    /// Current-step approver ids for any PENDING request(s) created here
    /// (clock-out and/or the auto-OT). Empty when auto-approved. Drives
    /// the silent realtime "refresh" of the supervisors' queues.
    pendingApproverIds: string[]
  }> {
    const prisma = getClient()
    const now = new Date()

    const employee = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { role: true, organizationId: true },
    })
    const orgId = employee?.organizationId ?? null
    // Local calendar day (org timezone), not UTC — must match how clock-in
    // stamped the record's `date`, else clock-out can't find today's row and
    // an early-morning shift is mis-read as a previous-day orphan.
    const tz = await this.getOrgTimezone(orgId)
    const today = startOfLocalDay(now, tz)

    // Resolve which open session this clock-out closes. The orphan dialog
    // passes an explicit id; the plain "Clock Out" button passes nothing —
    // and historically that path only looked at TODAY's record, so a session
    // left open on a PREVIOUS day (forgot to clock out, or the day rolled
    // over) was unreachable: clock-out threw NOT_CLOCKED_IN while the
    // clock-in guard threw ALREADY_CLOCKED_IN, trapping the employee on both
    // buttons. So when nothing was passed and there's no open session on
    // today's record, fall back to the same cross-day open session the
    // clock-in guard finds, and close THAT.
    let effectiveOrphanId = orphanedSessionId
    if (!effectiveOrphanId) {
      const hasOpenToday = await prisma.attendanceRecord.findFirst({
        where: {
          employeeId,
          date: today,
          sessions: { some: { endedAt: null } },
        },
        select: { id: true },
      })
      if (!hasOpenToday) {
        const orphan = await this.findOpenSessionAcrossDays(employeeId)
        if (orphan) effectiveOrphanId = orphan.sessionId
      }
    }

    // When closing an orphaned session from a previous day, load that
    // session's parent record instead of today's record.
    let existing: {
      id: string
      project: string | null
      projectId: string | null
      location: string | null
      notes: string | null
      timeIn: Date | null
      status: string
      clockInLat: number | null
      clockInLng: number | null
      clockInDistanceMeters: number | null
      sessions: { id: string; startedAt: Date; breaks: { startedAt: Date; endedAt: Date | null }[] }[]
    } | null = null
    let openSession: { id: string; startedAt: Date; breaks: { startedAt: Date; endedAt: Date | null }[] } | null = null

    if (effectiveOrphanId) {
      // Fetch session and its parent record separately to avoid Prisma
      // nested-select type inference issues where `session.record` is `never`.
      const orphanSession = await prisma.attendanceSession.findUnique({
        where: { id: effectiveOrphanId },
        select: {
          id: true,
          startedAt: true,
          attendanceRecordId: true,
          breaks: { select: { startedAt: true, endedAt: true } },
        },
      })
      if (!orphanSession) throw new Error("You're not clocked in right now.")
      const orphanRecord = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: orphanSession.attendanceRecordId },
        select: {
          id: true,
          project: true,
          projectId: true,
          location: true,
          notes: true,
          timeIn: true,
          status: true,
          clockInLat: true,
          clockInLng: true,
          clockInDistanceMeters: true,
        },
      })
      existing = { ...orphanRecord, sessions: [] }
      openSession = { id: orphanSession.id, startedAt: orphanSession.startedAt, breaks: orphanSession.breaks }

      // Also silently close any other orphaned sessions + their parent records
      // from previous days so the employee doesn't have to repeat this flow.
      const otherOrphanRecords = await prisma.attendanceRecord.findMany({
        where: {
          employeeId,
          date: { lt: today },
          sessions: { some: { endedAt: null, id: { not: effectiveOrphanId } } },
        },
        select: { id: true },
      })
      for (const r of otherOrphanRecords) {
        await prisma.attendanceSession.updateMany({
          where: { attendanceRecordId: r.id, endedAt: null, id: { not: effectiveOrphanId } },
          data: { endedAt: now, durationMin: 0 },
        })
        await prisma.attendanceRecord.update({
          where: { id: r.id },
          data: { timeOut: now, status: "CLOCKED_OUT" },
        })
      }
    } else {
      const record = await prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
        select: {
          id: true,
          project: true,
          projectId: true,
          location: true,
          notes: true,
          timeIn: true,
          status: true,
          clockInLat: true,
          clockInLng: true,
          clockInDistanceMeters: true,
          sessions: {
            where: { endedAt: null },
            orderBy: { startedAt: "desc" },
            take: 1,
            select: {
              id: true,
              startedAt: true,
              breaks: {
                select: { startedAt: true, endedAt: true },
              },
            },
          },
        },
      })
      existing = record

      if (!record?.sessions[0]) {
        // Migration gap: employee clocked in with the old code path which
        // didn't create an AttendanceSession. Create one retroactively so
        // this clock-out can proceed.
        if (record?.timeIn) {
          const retroSession = await prisma.attendanceSession.create({
            data: {
              attendanceRecordId: record.id,
              startedAt: record.timeIn,
              status: (record.status as AttendanceStatus) === "LATE" ? "LATE" : "ON_TIME",
              project: record.project ?? null,
              projectId: record.projectId ?? null,
              clockInLat: record.clockInLat ?? null,
              clockInLng: record.clockInLng ?? null,
              clockInDistanceMeters: record.clockInDistanceMeters ?? null,
            },
            select: { id: true, startedAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
          })
          openSession = retroSession
        } else {
          throw new Error("You're not clocked in right now.")
        }
      } else {
        openSession = record.sessions[0]
      }
    }

    if (!openSession || !existing) throw new Error("You're not clocked in right now.")

    // `tz` was resolved above (needed to compute the local `today`).
    const hours = await this.getWorkingHours(orgId, existing?.projectId ?? null)

    // Close any open break sessions on this session.
    await prisma.breakSession.updateMany({
      where: { attendanceSessionId: openSession.id, endedAt: null },
      data: { endedAt: now },
    })

    // Also close any orphaned breaks still attached to the record but not yet
    // linked to a session (legacy rows or races).
    await prisma.breakSession.updateMany({
      where: { attendanceRecordId: existing!.id, attendanceSessionId: null, endedAt: null },
      data: { endedAt: now },
    })

    // Sum break minutes for this session (re-fetch to capture the ones just closed).
    const sessionBreaks = await prisma.breakSession.findMany({
      where: { attendanceSessionId: openSession.id },
      select: { startedAt: true, endedAt: true },
    })
    let breakMin = 0
    for (const b of sessionBreaks) {
      const end = b.endedAt ?? now
      breakMin += Math.max(0, diffMinutes(b.startedAt, end))
    }

    // Clamp effective clock-in to the shift's working-hours start — anchored
    // to the day the SESSION started, not `now`. Anchoring to `now` breaks
    // shifts that cross midnight: an 11:59pm→2am shift would build the
    // expected start on the clock-OUT day (~9am the next day), clamp the
    // start forward past the actual clock-out, and record 0 minutes. Using
    // the clock-in day keeps cross-midnight shifts correct while still
    // trimming genuine early logins on same-day shifts.
    let effectiveTimeIn: Date = openSession.startedAt
    const expectedStart = expectedTimeOnLocalDay(openSession.startedAt, hours.start, tz)
    if (effectiveTimeIn.getTime() < expectedStart.getTime()) {
      effectiveTimeIn = expectedStart
    }
    const rawDurationMin = diffMinutes(effectiveTimeIn, now)
    const sessionDurationMin = Math.max(0, rawDurationMin - breakMin)

    const autoApprove = await shouldAutoApprove({
      employeeId,
      role: employee?.role,
      projectId: existing?.projectId ?? null,
      kind: "CLOCK_OUT",
    })

    // Close the session.
    await prisma.attendanceSession.update({
      where: { id: openSession.id },
      data: {
        endedAt: now,
        durationMin: sessionDurationMin,
        clockOutNotes: notes ?? null,
        ...(geo
          ? {
              clockOutLat: geo.lat,
              clockOutLng: geo.lng,
              clockOutDistanceMeters: geo.distanceMeters,
            }
          : {}),
      },
    })

    // Recompute the day-level rollup from all sessions.
    const rollup = await recomputeRecordRollup(existing!.id, prisma)
    const durationMin = rollup.durationMin

    // Update record with rollup + clock-out location/notes.
    const appendedNotes = notes
      ? [existing?.notes, `CLOCK_OUT: ${notes}`].filter(Boolean).join("\n")
      : undefined
    const record = await prisma.attendanceRecord.update({
      where: { id: existing!.id },
      data: {
        timeOut: rollup.timeOut,
        durationMin: rollup.durationMin,
        status: rollup.status,
        location: location ?? existing?.location ?? null,
        ...(appendedNotes !== undefined ? { notes: appendedNotes } : {}),
        ...(geo
          ? {
              clockOutLat: geo.lat,
              clockOutLng: geo.lng,
              clockOutDistanceMeters: geo.distanceMeters,
            }
          : {}),
      },
    })

    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "CLOCK_OUT",
        status: autoApprove ? "APPROVED" : "PENDING",
        date: today,
        eventAt: now,
        title: `Clock-out ${localHm(now, tz)}`,
        detail: buildApprovalDetail(
          durationMin
            ? `Shift duration ${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
            : "End of shift",
          notes,
        ),
        location: location ?? null,
        project: existing?.project ?? null,
        ...(autoApprove
          ? {
              reviewerId: employeeId,
              reviewedAt: now,
              reviewNotes: "Auto-approved (supervisor self-attendance)",
            }
          : {}),
      },
    })

    // Link the approval to this session.
    await prisma.attendanceSession.update({
      where: { id: openSession.id },
      data: { clockOutApprovalRequestId: approval.id },
    })

    const clockOutApproverIds = autoApprove
      ? []
      : await resolveCurrentApproverIds(
          approval.id,
          employeeId,
          "CLOCK_OUT",
          existing?.projectId ?? null,
        )
    return {
      recordId: record.id,
      approvalId: approval.id,
      pendingApproverIds: clockOutApproverIds,
    }
  },

  async startBreak(
    employeeId: string,
    location?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
  ): Promise<{ approvalId: string; pendingApproverIds: string[] }> {
    const prisma = getClient()
    const now = new Date()
    const tz = await this.getEmployeeTimezone(employeeId)
    const today = startOfLocalDay(now, tz)
    const [existing, employee] = await Promise.all([
      prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
        select: {
          id: true,
          project: true,
          projectId: true,
          notes: true,
          sessions: {
            where: { endedAt: null },
            orderBy: { startedAt: "desc" },
            take: 1,
            select: {
              id: true,
              breaks: { where: { endedAt: null }, select: { id: true } },
            },
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    const openSession = existing?.sessions[0] ?? null
    if (!openSession) {
      throw new Error("Clock in before starting a break.")
    }
    if (openSession.breaks.length > 0) {
      throw new Error("You're already on break.")
    }

    const appendedNotes = notes
      ? [existing!.notes, `BREAK_START: ${notes}`].filter(Boolean).join("\n")
      : undefined
    await prisma.$transaction([
      prisma.breakSession.create({
        data: {
          attendanceRecordId: existing!.id,
          attendanceSessionId: openSession.id,
          startedAt: now,
          ...(geo
            ? {
                startedAtLat: geo.lat,
                startedAtLng: geo.lng,
                startedAtDistanceMeters: geo.distanceMeters,
              }
            : {}),
        },
      }),
      ...(appendedNotes !== undefined
        ? [
            prisma.attendanceRecord.update({
              where: { id: existing!.id },
              data: { notes: appendedNotes },
            }),
          ]
        : []),
    ])

    const autoApprove = await shouldAutoApprove({
      employeeId,
      role: employee?.role,
      projectId: existing!.projectId ?? null,
      kind: "BREAK",
      breakSubtype: "start",
    })
    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "BREAK",
        status: autoApprove ? "APPROVED" : "PENDING",
        date: today,
        eventAt: now,
        title: `Break start ${localHm(now, tz)}`,
        detail: buildApprovalDetail(
          location ? `Started break at ${location}` : "Started break",
          notes,
        ),
        location: location ?? null,
        project: existing!.project ?? null,
        ...(autoApprove
          ? {
              reviewerId: employeeId,
              reviewedAt: now,
              reviewNotes: "Auto-approved (supervisor self-attendance)",
            }
          : {}),
      },
    })
    const pendingApproverIds = autoApprove
      ? []
      : await resolveCurrentApproverIds(
          approval.id,
          employeeId,
          "BREAK",
          existing!.projectId ?? null,
        )
    return { approvalId: approval.id, pendingApproverIds }
  },

  async endBreak(
    employeeId: string,
    location?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
  ): Promise<{ approvalId: string; pendingApproverIds: string[] }> {
    const prisma = getClient()
    const now = new Date()
    const tz = await this.getEmployeeTimezone(employeeId)
    const today = startOfLocalDay(now, tz)
    const [existing, employee] = await Promise.all([
      prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
        select: {
          id: true,
          project: true,
          projectId: true,
          notes: true,
          sessions: {
            where: { endedAt: null },
            orderBy: { startedAt: "desc" },
            take: 1,
            select: {
              id: true,
              breaks: {
                where: { endedAt: null },
                orderBy: { startedAt: "desc" },
                take: 1,
                select: { id: true, startedAt: true },
              },
            },
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    const openSession = existing?.sessions[0] ?? null
    const openBreak = openSession?.breaks[0] ?? null
    if (!existing || !openSession || !openBreak) {
      throw new Error("Start a break before ending one.")
    }

    const appendedNotes = notes
      ? [existing.notes, `BREAK_END: ${notes}`].filter(Boolean).join("\n")
      : undefined
    await prisma.$transaction([
      prisma.breakSession.update({
        where: { id: openBreak.id },
        data: {
          endedAt: now,
          ...(geo
            ? {
                endedAtLat: geo.lat,
                endedAtLng: geo.lng,
                endedAtDistanceMeters: geo.distanceMeters,
              }
            : {}),
        },
      }),
      ...(appendedNotes !== undefined
        ? [
            prisma.attendanceRecord.update({
              where: { id: existing.id },
              data: { notes: appendedNotes },
            }),
          ]
        : []),
    ])

    const breakMin = Math.max(0, diffMinutes(openBreak.startedAt, now))
    const autoApprove = await shouldAutoApprove({
      employeeId,
      role: employee?.role,
      projectId: existing.projectId ?? null,
      kind: "BREAK",
      breakSubtype: "end",
    })
    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "BREAK",
        status: autoApprove ? "APPROVED" : "PENDING",
        date: today,
        eventAt: now,
        title: `Break end ${localHm(now, tz)}`,
        detail: buildApprovalDetail(
          `${breakMin}m break${location ? ` • back at ${location}` : ""}`,
          notes,
        ),
        location: location ?? null,
        project: existing.project ?? null,
        ...(autoApprove
          ? {
              reviewerId: employeeId,
              reviewedAt: now,
              reviewNotes: "Auto-approved (supervisor self-attendance)",
            }
          : {}),
      },
    })
    const pendingApproverIds = autoApprove
      ? []
      : await resolveCurrentApproverIds(
          approval.id,
          employeeId,
          "BREAK",
          existing.projectId ?? null,
        )
    return { approvalId: approval.id, pendingApproverIds }
  },

  // ── Supervisor ────────────────────────────────────────────────────────

  /// Returns the userIds of every employee this supervisor could ever
  /// approve for, sourced from ApprovalChainStep rows where this user is
  /// the approver. This is the authoritative multi-layer chain — the
  /// per-request filter `currentStepApproverIds.includes(supervisorId)`
  /// then narrows it to "is it your step right now".
  async getTeamMemberIds(supervisorId: string): Promise<string[]> {
    const prisma = getClient()
    const chain = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisorId },
      distinct: ["employeeId"],
      select: { employeeId: true },
    })
    return Array.from(new Set(chain.map((c) => c.employeeId)))
  },

  /// Distinct projects + teams the given employees belong to. Populates
  /// the supervisor Team view's project/team filter dropdowns, so a
  /// supervisor toggles only across the projects their team is actually in.
  async getScopeOptionsForEmployees(
    orgId: string,
    employeeUserIds: string[],
  ): Promise<{
    projects: { id: string; name: string }[]
    teams: { id: string; name: string; projectName: string }[]
  }> {
    if (employeeUserIds.length === 0) return { projects: [], teams: [] }
    const prisma = getClient()
    const profiles = await prisma.employeeProfile.findMany({
      where: { userId: { in: employeeUserIds }, organizationId: orgId },
      select: {
        projectAssignments: {
          select: { project: { select: { id: true, name: true } } },
        },
        teamMemberships: {
          select: {
            team: {
              select: {
                id: true,
                name: true,
                project: { select: { name: true } },
              },
            },
          },
        },
      },
    })
    const projMap = new Map<string, string>()
    const teamMap = new Map<string, { name: string; projectName: string }>()
    for (const p of profiles) {
      for (const pa of p.projectAssignments) {
        if (pa.project) projMap.set(pa.project.id, pa.project.name)
      }
      for (const tm of p.teamMemberships) {
        if (tm.team) {
          teamMap.set(tm.team.id, {
            name: tm.team.name,
            projectName: tm.team.project?.name ?? "",
          })
        }
      }
    }
    return {
      projects: [...projMap]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      teams: [...teamMap]
        .map(([id, v]) => ({ id, name: v.name, projectName: v.projectName }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  },

  /**
   * Throws if `employeeId` is not in the supervisor's approval chain. Admin
   * paths skip this guard at the service layer.
   */
  async assertSupervisorCanEditEmployee(
    supervisorId: string,
    employeeId: string,
  ): Promise<void> {
    const ids = await this.getTeamMemberIds(supervisorId)
    if (!ids.includes(employeeId)) {
      throw new Error("You can only edit attendance for your direct reports.")
    }
  },

  /**
   * Supervisor/admin manual overwrite of an AttendanceRecord's clock-in
   * and/or clock-out timestamps. Recomputes `lateByMin`, `durationMin`,
   * and `status` consistently with the live clock-in / clock-out paths,
   * and writes an `AttendanceEditLog` row in the same transaction.
   *
   * Pass timeIn/timeOut as `null` to clear, `undefined` to leave unchanged.
   */
  async overrideAttendanceTimes(args: {
    attendanceRecordId: string
    editorId: string
    editorRole: "ADMIN" | "SUPERVISOR"
    source: "DIRECT_EDIT" | "APPROVE_OVERRIDE" | "APPROVAL_REJECTION"
    timeIn?: Date | null
    timeOut?: Date | null
    reason?: string | null
  }): Promise<{
    id: string
    timeIn: Date | null
    timeOut: Date | null
    /// Approver IDs of the FIRST step of any OT ApprovalRequest this
    /// override auto-created. The service publishes a realtime "refresh"
    /// event to these so the next supervisor's badge updates live;
    /// otherwise their sidebar pill stays stale until they navigate.
    /// Empty when no OT was auto-created or when the OT was auto-
    /// approved (no pending step).
    pendingApproverIds: string[]
  }> {
    const prisma = getClient()
    const existing = await prisma.attendanceRecord.findUnique({
      where: { id: args.attendanceRecordId },
      select: {
        id: true,
        employeeId: true,
        date: true,
        timeIn: true,
        timeOut: true,
        status: true,
        notes: true,
        projectId: true,
        // Legacy free-string project label, mirrored onto a new OT
        // ApprovalRequest so the OT row sits alongside the rest of the
        // employee's queue with the same project tag.
        project: true,
        employee: { select: { organizationId: true, role: true } },
      },
    })
    if (!existing) throw new Error("Attendance record not found.")

    const nextTimeIn =
      args.timeIn === undefined ? existing.timeIn : args.timeIn
    const nextTimeOut =
      args.timeOut === undefined ? existing.timeOut : args.timeOut

    // Recompute late + status when timeIn changed.
    let lateByMin: number | null = null
    let nextStatus: AttendanceStatus = existing.status
    if (nextTimeIn) {
      const orgId = existing.employee?.organizationId ?? null
      const [hours, tz] = await Promise.all([
        this.getWorkingHours(orgId, existing.projectId ?? null),
        this.getOrgTimezone(orgId),
      ])
      const expected = expectedTimeOnLocalDay(nextTimeIn, hours.start, tz)
      const diff = diffMinutes(expected, nextTimeIn)
      const lateMin = diff > 0 ? diff : 0
      lateByMin = lateMin > 0 ? lateMin : null
      nextStatus = lateMin > 0 ? "LATE" : "ON_TIME"
    }
    if (nextTimeOut) {
      nextStatus = "CLOCKED_OUT"
    } else if (!nextTimeIn) {
      nextStatus = "MISSING"
    }

    // Recompute durationMin when both ends present. Mirrors the clamp +
    // break-subtract logic in clockOut.
    let durationMin: number | null = null
    if (nextTimeIn && nextTimeOut) {
      const orgId = existing.employee?.organizationId ?? null
      const [hours, tz] = await Promise.all([
        this.getWorkingHours(orgId, existing.projectId ?? null),
        this.getOrgTimezone(orgId),
      ])
      const expectedStart = expectedTimeOnLocalDay(nextTimeIn, hours.start, tz)
      const effectiveIn =
        nextTimeIn.getTime() < expectedStart.getTime()
          ? expectedStart
          : nextTimeIn
      const breaks = await prisma.breakSession.findMany({
        where: { attendanceRecordId: existing.id },
        select: { startedAt: true, endedAt: true },
      })
      const breakMin = breaks.reduce((sum, b) => {
        const end = b.endedAt ?? nextTimeOut
        return sum + Math.max(0, diffMinutes(b.startedAt, end))
      }, 0)
      const raw = diffMinutes(effectiveIn, nextTimeOut)
      durationMin = raw === null ? null : Math.max(0, raw - breakMin)
    }

    const [, logRow] = await prisma.$transaction([
      prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          timeIn: nextTimeIn,
          timeOut: nextTimeOut,
          lateByMin,
          durationMin,
          status: nextStatus,
        },
      }),
      prisma.attendanceEditLog.create({
        data: {
          attendanceRecordId: existing.id,
          editedById: args.editorId,
          editorRole: args.editorRole,
          reason: args.reason?.trim() || null,
          prevTimeIn: existing.timeIn,
          nextTimeIn,
          prevTimeOut: existing.timeOut,
          nextTimeOut,
          prevStatus: existing.status,
          nextStatus,
          prevNotes: existing.notes,
          nextNotes: existing.notes,
          source: args.source,
        },
      }),
    ])
    void logRow

    return {
      id: existing.id,
      timeIn: nextTimeIn,
      timeOut: nextTimeOut,
      pendingApproverIds: [],
    }
  },

  /**
   * Returns every BreakSession on a given AttendanceRecord, ordered by
   * `startedAt`. Used by the session-editor diff in the service layer.
   */
  async getBreakSessionsForRecord(
    attendanceRecordId: string,
  ): Promise<Array<{ id: string; startedAt: Date; endedAt: Date | null }>> {
    const prisma = getClient()
    return prisma.breakSession.findMany({
      where: { attendanceRecordId },
      orderBy: { startedAt: "asc" },
      select: { id: true, startedAt: true, endedAt: true },
    })
  },

  /**
   * Recompute `AttendanceRecord.durationMin` from the current timeIn /
   * timeOut and the current BreakSession rows. No-ops when the record
   * doesn't have both clock ends set (duration is meaningless then).
   * Used after break edits to keep the worked-minutes field in sync.
   */
  async recomputeDurationMin(attendanceRecordId: string): Promise<void> {
    const prisma = getClient()
    const record = await prisma.attendanceRecord.findUnique({
      where: { id: attendanceRecordId },
      select: {
        id: true,
        timeIn: true,
        timeOut: true,
        projectId: true,
        employee: { select: { organizationId: true } },
      },
    })
    if (!record) return
    if (!record.timeIn || !record.timeOut) {
      await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { durationMin: null },
      })
      return
    }
    const orgId = record.employee?.organizationId ?? null
    const [hours, tz] = await Promise.all([
      this.getWorkingHours(orgId, record.projectId ?? null),
      this.getOrgTimezone(orgId),
    ])
    const expectedStart = expectedTimeOnLocalDay(record.timeIn, hours.start, tz)
    const effectiveIn =
      record.timeIn.getTime() < expectedStart.getTime() ? expectedStart : record.timeIn
    const breaks = await prisma.breakSession.findMany({
      where: { attendanceRecordId: record.id },
      select: { startedAt: true, endedAt: true },
    })
    const timeOut = record.timeOut
    const breakMin = breaks.reduce((sum, b) => {
      const end = b.endedAt ?? timeOut
      return sum + Math.max(0, diffMinutes(b.startedAt, end))
    }, 0)
    const raw = diffMinutes(effectiveIn, timeOut)
    const durationMin = raw === null ? null : Math.max(0, raw - breakMin)
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { durationMin },
    })
  },

  /**
   * Supervisor/admin override of a single BreakSession's start/end times.
   * Writes a `BreakSessionEditLog` row and triggers a `durationMin`
   * recompute on the parent AttendanceRecord. Pass `endedAt: null` to
   * mark the break still-open; pass `startedAt: undefined` to keep it.
   */
  async overrideBreakSession(args: {
    breakSessionId: string
    editorId: string
    editorRole: "ADMIN" | "SUPERVISOR"
    source: "DIRECT_EDIT" | "APPROVAL_REJECTION"
    startedAt?: Date
    endedAt?: Date | null
    reason?: string | null
  }): Promise<void> {
    const prisma = getClient()
    const existing = await prisma.breakSession.findUnique({
      where: { id: args.breakSessionId },
      select: {
        id: true,
        attendanceRecordId: true,
        startedAt: true,
        endedAt: true,
      },
    })
    if (!existing) throw new Error("Break session not found.")
    const nextStartedAt = args.startedAt ?? existing.startedAt
    const nextEndedAt =
      args.endedAt === undefined ? existing.endedAt : args.endedAt
    await prisma.$transaction([
      prisma.breakSession.update({
        where: { id: existing.id },
        data: { startedAt: nextStartedAt, endedAt: nextEndedAt },
      }),
      prisma.breakSessionEditLog.create({
        data: {
          breakSessionId: existing.id,
          attendanceRecordId: existing.attendanceRecordId,
          editedById: args.editorId,
          editorRole: args.editorRole,
          reason: args.reason?.trim() || null,
          prevStartedAt: existing.startedAt,
          nextStartedAt,
          prevEndedAt: existing.endedAt,
          nextEndedAt,
          source: args.source,
        },
      }),
    ])
    await this.recomputeDurationMin(existing.attendanceRecordId)
  },

  /**
   * Supervisor/admin creates a BreakSession the employee forgot to log.
   * Writes a `BreakSessionEditLog` with `source = "CREATE"` and
   * recomputes `durationMin`.
   */
  async createBreakSessionAsEditor(args: {
    attendanceRecordId: string
    editorId: string
    editorRole: "ADMIN" | "SUPERVISOR"
    startedAt: Date
    endedAt: Date | null
    reason?: string | null
  }): Promise<{ id: string }> {
    const prisma = getClient()
    const record = await prisma.attendanceRecord.findUnique({
      where: { id: args.attendanceRecordId },
      select: { id: true },
    })
    if (!record) throw new Error("Attendance record not found.")
    const created = await prisma.breakSession.create({
      data: {
        attendanceRecordId: args.attendanceRecordId,
        startedAt: args.startedAt,
        endedAt: args.endedAt,
      },
      select: { id: true },
    })
    await prisma.breakSessionEditLog.create({
      data: {
        breakSessionId: created.id,
        attendanceRecordId: args.attendanceRecordId,
        editedById: args.editorId,
        editorRole: args.editorRole,
        reason: args.reason?.trim() || null,
        prevStartedAt: null,
        nextStartedAt: args.startedAt,
        prevEndedAt: null,
        nextEndedAt: args.endedAt,
        source: "CREATE",
      },
    })
    await this.recomputeDurationMin(args.attendanceRecordId)
    return { id: created.id }
  },

  /**
   * Supervisor/admin deletes a BreakSession. Writes a
   * `BreakSessionEditLog` with `source = "DELETE"` so the audit trail is
   * preserved (the log row's `breakSessionId` becomes null once the
   * referenced row is gone, courtesy of `SetNull`). Recomputes
   * `durationMin` afterward.
   */
  async deleteBreakSessionAsEditor(args: {
    breakSessionId: string
    editorId: string
    editorRole: "ADMIN" | "SUPERVISOR"
    reason?: string | null
  }): Promise<void> {
    const prisma = getClient()
    const existing = await prisma.breakSession.findUnique({
      where: { id: args.breakSessionId },
      select: {
        id: true,
        attendanceRecordId: true,
        startedAt: true,
        endedAt: true,
      },
    })
    if (!existing) throw new Error("Break session not found.")
    await prisma.breakSessionEditLog.create({
      data: {
        breakSessionId: existing.id,
        attendanceRecordId: existing.attendanceRecordId,
        editedById: args.editorId,
        editorRole: args.editorRole,
        reason: args.reason?.trim() || null,
        prevStartedAt: existing.startedAt,
        nextStartedAt: null,
        prevEndedAt: existing.endedAt,
        nextEndedAt: null,
        source: "DELETE",
      },
    })
    await prisma.breakSession.delete({ where: { id: existing.id } })
    await this.recomputeDurationMin(existing.attendanceRecordId)
  },

  /**
   * Employee-side: update the remark (`notes`) on their own current-day
   * attendance record. Throws if the record isn't theirs or isn't today.
   */
  async updateAttendanceRemark(args: {
    attendanceRecordId: string
    employeeId: string
    remark: string | null
  }): Promise<void> {
    const prisma = getClient()
    const existing = await prisma.attendanceRecord.findUnique({
      where: { id: args.attendanceRecordId },
      select: { id: true, employeeId: true, date: true, remark: true },
    })
    if (!existing) throw new Error("Attendance record not found.")
    if (existing.employeeId !== args.employeeId) {
      throw new Error("You can only edit your own attendance.")
    }
    const tz = await this.getEmployeeTimezone(args.employeeId)
    const today = startOfLocalDay(new Date(), tz)
    if (existing.date.getTime() !== today.getTime()) {
      throw new Error("Remarks can only be edited on today's record.")
    }
    const trimmed = args.remark?.trim() ?? null
    const nextRemark = trimmed && trimmed.length > 0 ? trimmed : null
    await prisma.$transaction([
      prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { remark: nextRemark },
      }),
      prisma.attendanceEditLog.create({
        data: {
          attendanceRecordId: existing.id,
          editedById: args.employeeId,
          editorRole: "EMPLOYEE",
          source: "EMPLOYEE_REMARK",
          prevRemark: existing.remark,
          nextRemark,
        },
      }),
    ])
  },

  async getTeamOverview(supervisorId: string): Promise<SupervisorTeamOverview> {
    const prisma = getClient()
    const tz = await this.getEmployeeTimezone(supervisorId)
    const today = startOfLocalDay(new Date(), tz)

    const memberIds = await this.getTeamMemberIds(supervisorId)
    const users = memberIds.length
      ? await prisma.user.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, name: true },
        })
      : []

    const todays = memberIds.length
      ? await prisma.attendanceRecord.findMany({
          where: { employeeId: { in: memberIds }, date: today },
        })
      : []
    const byMember = new Map(todays.map((r) => [r.employeeId, r]))

    const presentToday = todays.filter(
      (r) => r.status === "ON_TIME" || r.status === "LATE" || r.status === "CLOCKED_IN",
    ).length
    const lateToday = todays.filter((r) => r.status === "LATE").length
    const onLeaveToday = todays.filter((r) => r.status === "ON_LEAVE").length

    const pendingApprovals = memberIds.length
      ? await prisma.approvalRequest.count({
          where: { employeeId: { in: memberIds }, status: "PENDING" },
        })
      : 0

    return {
      teamSize: memberIds.length,
      presentToday,
      lateToday,
      onLeaveToday,
      pendingApprovals,
      team: users.map((u) => ({
        employeeId: u.id,
        name: u.name,
        initials: buildInitials(u.name),
        today: byMember.get(u.id) ? attendanceToView(byMember.get(u.id)!) : null,
      })),
    }
  },

  async getPendingApprovalsForSupervisor(
    supervisorId: string,
  ): Promise<ApprovalRequestView[]> {
    const prisma = getClient()
    const memberIds = await this.getTeamMemberIds(supervisorId)
    if (memberIds.length === 0) return []
    const records = await prisma.approvalRequest.findMany({
      where: { employeeId: { in: memberIds }, status: "PENDING" },
      orderBy: { submittedAt: "desc" },
      include: {
        employee: { select: { name: true } },
        otAttachments: { orderBy: { createdAt: "asc" } },
      },
      take: 100,
    })
    const baseViews = records.map((r) => ({
      ...approvalToView(r),
      attachments: r.otAttachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileUrl: a.fileUrl,
        mimeType: a.mimeType,
        uploadedAt: a.createdAt.toISOString(),
        kind: a.kind as "JUSTIFICATION" | "EVIDENCE",
      })),
    }))
    const withContext = await attachChainContext(baseViews)
    // Only show requests where this supervisor is among the current step's
    // approvers — multi-layer chain enforcement.
    const filtered = withContext.filter((v) =>
      v.currentStepApproverIds.includes(supervisorId),
    )
    return backfillLateMinutes(filtered, prisma)
  },

  async getReviewedOtForSupervisor(
    supervisorId: string,
  ): Promise<ApprovalRequestView[]> {
    const prisma = getClient()
    const memberIds = await this.getTeamMemberIds(supervisorId)
    if (memberIds.length === 0) return []
    const records = await prisma.approvalRequest.findMany({
      where: {
        employeeId: { in: memberIds },
        kind: "OT",
        status: { in: ["APPROVED", "REJECTED"] },
      },
      orderBy: { reviewedAt: "desc" },
      include: {
        employee: { select: { name: true } },
        otAttachments: { orderBy: { createdAt: "asc" } },
      },
      take: 50,
    })
    return records.map((r) => ({
      ...approvalToView(r),
      attachments: r.otAttachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileUrl: a.fileUrl,
        mimeType: a.mimeType,
        uploadedAt: a.createdAt.toISOString(),
        kind: a.kind as "JUSTIFICATION" | "EVIDENCE",
      })),
    }))
  },

  async getEmployeeProfile(employeeId: string): Promise<{
    id: string
    name: string
    email: string
    role: string
    initials: string
    jobTitle: string | null
    project: string | null
    employeeIdRef: string | null
    organizationId: string | null
    supervisorName: string | null
  } | null> {
    const prisma = getClient()
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        organizationId: true,
        employeeProfiles: {
          select: {
            employeeId: true,
            jobTitle: true,
            projectAssignments: {
              select: { project: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
          take: 1,
        },
        approvalChainSteps: {
          where: { step: 1 },
          select: { approver: { select: { name: true } } },
          take: 1,
        },
      },
    })
    if (!user) return null
    const profile = user.employeeProfiles[0] ?? null
    const primaryProject = profile?.projectAssignments?.[0]?.project?.name ?? null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      initials: buildInitials(user.name),
      jobTitle: profile?.jobTitle ?? null,
      project: primaryProject,
      employeeIdRef: profile?.employeeId ?? null,
      organizationId: user.organizationId,
      supervisorName: user.approvalChainSteps?.[0]?.approver.name ?? null,
    }
  },

  async getOrgEmployeeList(
    orgId: string | null,
    options?: { policyIdScope?: string[] | null },
  ): Promise<
    Array<{
      id: string
      name: string
      email: string
      role: string
      initials: string
      jobTitle: string | null
      project: string | null
      todayStatus: AttendanceStatus | null
      todayTimeIn: string | null
      monthActualMin: number
      monthExpectedMin: number
    }>
  > {
    if (!orgId) return []
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const prisma = getClient()
    const tz = await this.getOrgTimezone(orgId)
    const today = startOfLocalDay(new Date(), tz)
    const users = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(policyIdScope && policyIdScope.length > 0
          ? { employeeProfiles: { some: { policyId: { in: policyIdScope } } } }
          : {}),
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        employeeProfiles: {
          select: {
            id: true,
            jobTitle: true,
            projectAssignments: {
              select: {
                project: {
                  select: {
                    name: true,
                    workingHoursStart: true,
                    workingHoursEnd: true,
                    workingDays: true,
                    lunchBreakMinutes: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    })
    if (users.length === 0) return []
    const todayRecords = await prisma.attendanceRecord.findMany({
      where: { date: today, employeeId: { in: users.map((u) => u.id) } },
      select: { employeeId: true, status: true, timeIn: true },
    })
    const byUser = new Map(todayRecords.map((r) => [r.employeeId, r]))

    // Month range: start of month → today (month-to-date)
    const now = new Date()
    const monthFrom = startOfDay(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    )
    const monthTo = endOfDay(now)

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { workingHoursStart: true, workingHoursEnd: true },
    })

    const monthDurations = await prisma.attendanceRecord.groupBy({
      by: ["employeeId"],
      where: {
        employeeId: { in: users.map((u) => u.id) },
        date: { gte: monthFrom, lte: monthTo },
        durationMin: { not: null },
      },
      _sum: { durationMin: true },
    })
    const actualByUser = new Map(
      monthDurations.map((d) => [d.employeeId, d._sum.durationMin ?? 0]),
    )

    return Promise.all(users.map(async (u) => {
      const today = byUser.get(u.id)
      const profile = u.employeeProfiles[0] ?? null
      const primary = profile?.projectAssignments?.[0]?.project ?? null
      const projectName =
        profile?.projectAssignments
          ?.map((a) => a.project.name)
          .join(", ") || null
      const start = primary?.workingHoursStart ?? org?.workingHoursStart ?? "09:00"
      const end = primary?.workingHoursEnd ?? org?.workingHoursEnd ?? "18:00"
      const lunch = primary?.lunchBreakMinutes ?? DEFAULT_LUNCH_BREAK_MIN
      const workingDays = parseWorkingDays(primary?.workingDays ?? null)
      const standardDailyMin = standardDailyMinutesFrom(start, end, lunch)
      const scheduledMin = expectedMinutesForRange({
        from: monthFrom,
        to: monthTo,
        workingDays,
        standardDailyMin,
      })
      const leaveDeduction = profile?.id
        ? await paidLeaveMinutes(profile.id, monthFrom, monthTo, standardDailyMin)
        : 0
      const monthExpectedMin = Math.max(0, scheduledMin - leaveDeduction)
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        initials: buildInitials(u.name),
        jobTitle: u.employeeProfiles[0]?.jobTitle ?? null,
        project: projectName,
        todayStatus: (today?.status as AttendanceStatus | undefined) ?? null,
        todayTimeIn: today?.timeIn?.toISOString() ?? null,
        monthActualMin: actualByUser.get(u.id) ?? 0,
        monthExpectedMin,
      }
    }))
  },

  async getDailyActivity(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
    options?: {
      policyIdScope?: string[] | null
      /// Restrict the roll-call to these user ids (e.g. a supervisor's
      /// team). Intersected with any project/team/search scope.
      restrictToEmployeeIds?: string[] | null
    },
  ): Promise<
    Array<{
      id: string
      name: string
      jobTitle: string | null
      project: string | null
      timeIn: string | null
      timeOut: string | null
      status: AttendanceStatus | null
      derivedStatus:
        | "WORKING"
        | "ON_BREAK"
        | "CLOCKED_OUT"
        | "NOT_CLOCKED_IN"
        | "ON_LEAVE"
        | null
      clockInDistanceMeters: number | null
      clockInLat: number | null
      clockInLng: number | null
      clockOutLat: number | null
      clockOutLng: number | null
      offSite: boolean
      attendanceRecordId: string | null
      hasSelfie: boolean
      hasClockOutSelfie: boolean
      sessions: AttendanceSessionView[]
    }>
  > {
    if (!orgId) return []
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const restrict = options?.restrictToEmployeeIds ?? null
    if (restrict && restrict.length === 0) return []
    const prisma = getClient()
    const tz = await this.getOrgTimezone(orgId)
    const today = startOfLocalDay(new Date(), tz)

    let employeeIds = await this.resolveScopedEmployeeIds(orgId, {
      projectId,
      teamId,
      q,
    })
    // Intersect the project/team/search scope with the supervisor-team
    // restriction (either can be null = no restriction on that axis).
    if (restrict) {
      employeeIds = employeeIds
        ? employeeIds.filter((id) => restrict.includes(id))
        : restrict
    }
    if (employeeIds && employeeIds.length === 0) return []

    const users = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
        ...(policyIdScope && policyIdScope.length > 0
          ? { employeeProfiles: { some: { policyId: { in: policyIdScope } } } }
          : {}),
      },
      orderBy: [{ name: "asc" }],
      select: {
        id: true,
        name: true,
        employeeProfiles: {
          select: {
            jobTitle: true,
            projectAssignments: {
              select: { project: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    })
    if (users.length === 0) return []
    const records = await prisma.attendanceRecord.findMany({
      where: {
        date: today,
        employeeId: { in: users.map((u) => u.id) },
        ...(projectId ? { projectId } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        status: true,
        lateByMin: true,
        timeIn: true,
        timeOut: true,
        clockInDistanceMeters: true,
        clockInLat: true,
        clockInLng: true,
        clockOutLat: true,
        clockOutLng: true,
        notes: true,
        xeroSelfieFileId: true,
        clockOutXeroSelfieFileId: true,
        sessions: {
          orderBy: { startedAt: "asc" },
          select: SESSION_SELECT,
        },
      },
    })
    const byUser = new Map(records.map((r) => [r.employeeId, r]))

    // Active break overlay: check open BreakSessions on the open AttendanceSession.
    const openSessionIds = records
      .flatMap((r) => r.sessions)
      .filter((s) => s.endedAt === null)
      .map((s) => s.id)
    const activeBreakSessionIds = new Set<string>()
    if (openSessionIds.length > 0) {
      const breaks = await prisma.breakSession.findMany({
        where: {
          attendanceSessionId: { in: openSessionIds },
          endedAt: null,
        },
        select: { attendanceSessionId: true },
      })
      for (const b of breaks) {
        if (b.attendanceSessionId) activeBreakSessionIds.add(b.attendanceSessionId)
      }
    }

    const radius = await this.getGeofenceRadiusForOrganization(orgId)
    const radiusM = radius ?? 200

    return users
      // Every in-scope employee appears in the unified roster; those with
      // no record today fall through as NOT_CLOCKED_IN so the "No clock-in"
      // pill can surface them (this table subsumes the old roll call +
      // off-site cards).
      .map((u) => {
      const rec = byUser.get(u.id)
      const projectName =
        u.employeeProfiles[0]?.projectAssignments
          ?.map((a) => a.project.name)
          .join(", ") || null

      const status = (rec?.status as AttendanceStatus | undefined) ?? null
      const openSession = (rec?.sessions ?? []).find((s) => s.endedAt === null)
      let derivedStatus:
        | "WORKING"
        | "ON_BREAK"
        | "CLOCKED_OUT"
        | "NOT_CLOCKED_IN"
        | "ON_LEAVE"
        | null = null
      if (status === "ON_LEAVE") {
        derivedStatus = "ON_LEAVE"
      } else if (status === "CLOCKED_OUT") {
        derivedStatus = "CLOCKED_OUT"
      } else if (openSession) {
        derivedStatus = activeBreakSessionIds.has(openSession.id)
          ? "ON_BREAK"
          : "WORKING"
      } else if (!rec || !rec.timeIn) {
        derivedStatus = "NOT_CLOCKED_IN"
      }

      const clockInDistanceMeters = rec?.clockInDistanceMeters ?? null
      // Off-site when the clock GPS is beyond the geofence radius OR the
      // record carries an off-site remark (`notes`). The remark path matters
      // for a face-scan / no-GPS off-site clock-in (e.g. guard house): the
      // reason is captured in `notes` but no distance is recorded, so a
      // distance-only check would let it slip through as on-site.
      const offSite =
        (clockInDistanceMeters != null && clockInDistanceMeters > radiusM) ||
        (rec?.notes != null && rec.notes.trim() !== "")

      const sessions: AttendanceSessionView[] = (rec?.sessions ?? []).map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        durationMin: s.durationMin,
        status: s.status as AttendanceStatus,
        clockInLat: s.clockInLat,
        clockInLng: s.clockInLng,
        clockOutLat: s.clockOutLat,
        clockOutLng: s.clockOutLng,
        clockInNotes: s.clockInNotes,
        clockOutNotes: s.clockOutNotes,
      }))

      // Late = clocked in late today. Prefer the per-session snapshot
      // (survives clock-out, which overwrites record.status) and fall back
      // to the record status for legacy rows without sessions.
      const lateByMin = rec?.lateByMin ?? null
      const late =
        status === "LATE" || sessions.some((s) => s.status === "LATE")

      return {
        id: u.id,
        name: u.name,
        jobTitle: u.employeeProfiles[0]?.jobTitle ?? null,
        project: projectName,
        timeIn: rec?.timeIn?.toISOString() ?? null,
        timeOut: rec?.timeOut?.toISOString() ?? null,
        status,
        derivedStatus,
        clockInDistanceMeters,
        clockInLat: rec?.clockInLat ?? null,
        clockInLng: rec?.clockInLng ?? null,
        clockOutLat: rec?.clockOutLat ?? null,
        clockOutLng: rec?.clockOutLng ?? null,
        offSite,
        late,
        lateByMin,
        attendanceRecordId: rec?.id ?? null,
        hasSelfie: !!rec?.xeroSelfieFileId,
        hasClockOutSelfie: !!rec?.clockOutXeroSelfieFileId,
        sessions,
      }
    })
  },

  async getEmployeeMonthSummary(
    employeeId: string,
    monthStart: Date,
  ): Promise<{
    totalMin: number
    onTime: number
    late: number
    missing: number
    offSite: number
  }> {
    const prisma = getClient()
    const monthEnd = new Date(monthStart)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1)
    const records = await prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: monthStart, lt: monthEnd } },
      select: { durationMin: true, status: true, notes: true },
    })
    return {
      totalMin: records.reduce((acc, r) => acc + (r.durationMin ?? 0), 0),
      onTime: records.filter((r) => r.status === "ON_TIME").length,
      late: records.filter((r) => r.status === "LATE").length,
      missing: records.filter((r) => r.status === "MISSING").length,
      // Off-site == the day carried an off-site remark (same signal the
      // roll-call uses). Distance alone isn't enough — no-GPS off-site
      // clock-ins record only the remark.
      offSite: records.filter((r) => r.notes != null && r.notes.trim() !== "")
        .length,
    }
  },

  async countPendingApprovalsForSupervisor(supervisorId: string): Promise<number> {
    // Delegate to the queue query so the count CANNOT diverge from what
    // the supervisor actually sees. A naive
    // `approvalRequest.count({ status: "PENDING" })` over team members
    // counts requests that are pending the NEXT step's approvers too —
    // leaving a stuck red dot when the supervisor's own queue is empty.
    // The queue method applies the same multi-step chain filter
    // (`currentStepApproverIds.includes(supervisorId)`) so this guarantees
    // badge == queue length. Capped at 100 by the queue's `take` —
    // acceptable for a sidebar badge.
    const queue = await this.getPendingApprovalsForSupervisor(supervisorId)
    return queue.length
  },

  async reviewApproval(
    approvalId: string,
    reviewerId: string,
    status: "APPROVED" | "REJECTED",
    notes?: string,
    overrideEventAt?: Date | null,
  ): Promise<{
    employeeUserId: string
    kind: string
    finalStatus: "PENDING" | "APPROVED" | "REJECTED"
    /// Approvers at the NEXT step — set only when an APPROVAL advanced
    /// the chain (still PENDING). The service notifies them so the
    /// request appears live in their queue + bell.
    nextApproverIds: string[]
    /// Other approvers at the step just acted on (excluding the
    /// reviewer) — nudged so the request leaves their queue live.
    peerApproverIds: string[]
  }> {
    const prisma = getClient()
    const now = new Date()

    const request = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      select: {
        id: true,
        employeeId: true,
        kind: true,
        status: true,
        reviewerId: true,
        chainHistory: true,
        date: true,
        otPayoutMethod: true,
        otStartAt: true,
        otEndAt: true,
        // Carry-forward time: each step that applies an override writes
        // back to `eventAt`, so subsequent reviewers (and the final-step
        // apply-to-AttendanceRecord branch below) see the latest proposed
        // value, not the original submission.
        eventAt: true,
      },
    })
    if (!request) throw new Error("Approval not found.")
    if (request.status !== "PENDING") {
      throw new Error("This request has already been finalised.")
    }

    // Resolve which project this approval belongs to (for chain selection).
    // Use the AttendanceRecord on the same employee+date.
    const attendance = await prisma.attendanceRecord.findUnique({
      where: {
        employeeId_date: { employeeId: request.employeeId, date: request.date },
      },
      select: { projectId: true },
    })

    const ctx = await resolveApprovalContext({
      requestId: request.id,
      employeeId: request.employeeId,
      kind: request.kind as "CLOCK_IN" | "CLOCK_OUT" | "BREAK" | "OT",
      status: "PENDING",
      reviewerId: request.reviewerId,
      projectId: attendance?.projectId ?? null,
    })

    if (ctx.currentStep === null || ctx.chain.length === 0) {
      throw new Error("No approver chain configured for this request.")
    }

    const stepEntry = ctx.chain[ctx.currentStep - 1]
    const reviewerInStep = stepEntry?.approvers.some(
      (a) => a.approverId === reviewerId,
    )
    if (!reviewerInStep) {
      throw new Error("Not your turn to review this request.")
    }

    // Look up the reviewer's display name (best-effort) so we can store it
    // in chainHistory without needing to join later.
    const reviewer = await prisma.user.findUnique({
      where: { id: reviewerId },
      select: { name: true },
    })

    const existingHistory: ChainHistoryEntry[] = Array.isArray(request.chainHistory)
      ? (request.chainHistory as unknown as ChainHistoryEntry[])
      : []
    const newEntry: ChainHistoryEntry = {
      step: ctx.currentStep,
      approverId: reviewerId,
      approverName: reviewer?.name ?? reviewerId,
      reviewedAt: now.toISOString(),
      status,
      notes: notes ?? null,
    }
    const nextHistory = [...existingHistory, newEntry]

    const isLastStep = ctx.currentStep === ctx.chain.length
    const finalStatus: "PENDING" | "APPROVED" | "REJECTED" =
      status === "REJECTED" ? "REJECTED" : isLastStep ? "APPROVED" : "PENDING"

    // Realtime fan-out targets (computed from the chain we already have).
    const peerApproverIds = (stepEntry?.approvers ?? [])
      .map((a) => a.approverId)
      .filter((id) => id !== reviewerId)
    const nextApproverIds =
      finalStatus === "PENDING"
        ? (ctx.chain[ctx.currentStep]?.approvers ?? []).map((a) => a.approverId)
        : []

    // When the reviewer adjusted the time, persist it on the request so
    // subsequent reviewers (and the final-step apply branch below) see the
    // edit instead of the original submission. Skipped on rejection.
    const carriesOverride =
      status !== "REJECTED" &&
      overrideEventAt != null &&
      (request.kind === "CLOCK_IN" || request.kind === "CLOCK_OUT")

    await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: finalStatus,
        reviewerId,
        reviewedAt: now,
        reviewNotes: notes ?? null,
        chainHistory: nextHistory as unknown as object,
        ...(carriesOverride ? { eventAt: overrideEventAt } : {}),
      },
    })

    // Rejection of a CLOCK_IN/CLOCK_OUT propagates back to the underlying
    // AttendanceRecord so the employee returns to the correct pre-state
    // (not-clocked-in for CLOCK_IN, still-clocked-in for CLOCK_OUT) and the
    // recorded time isn't silently counted by downstream reports.
    if (
      finalStatus === "REJECTED" &&
      (request.kind === "CLOCK_IN" || request.kind === "CLOCK_OUT") &&
      attendance
    ) {
      const fullRecord = await prisma.attendanceRecord.findUnique({
        where: {
          employeeId_date: { employeeId: request.employeeId, date: request.date },
        },
        select: { id: true },
      })
      if (fullRecord) {
        if (request.kind === "CLOCK_IN") {
          // Any breaks started under this now-rejected clock-in are wiped.
          await prisma.breakSession.deleteMany({
            where: { attendanceRecordId: fullRecord.id },
          })
          await this.overrideAttendanceTimes({
            attendanceRecordId: fullRecord.id,
            editorId: reviewerId,
            editorRole: "SUPERVISOR",
            source: "APPROVAL_REJECTION",
            timeIn: null,
            timeOut: null,
            reason: notes ?? "Clock-in rejected",
          })
        } else {
          await this.overrideAttendanceTimes({
            attendanceRecordId: fullRecord.id,
            editorId: reviewerId,
            editorRole: "SUPERVISOR",
            source: "APPROVAL_REJECTION",
            timeOut: null,
            reason: notes ?? "Clock-out rejected",
          })
        }
      }
    }

    // Apply-on-final-approval: when a CLOCK_IN/CLOCK_OUT chain reaches the
    // last step, commit the **effective** time to the underlying
    // AttendanceRecord. The effective time is THIS step's override if the
    // reviewer adjusted, otherwise the carried-forward eventAt from a
    // prior step that did. The no-op short-circuit (current time already
    // equals the effective time) avoids creating an empty audit row when
    // no edit ever happened anywhere in the chain.
    if (
      finalStatus === "APPROVED" &&
      (request.kind === "CLOCK_IN" || request.kind === "CLOCK_OUT") &&
      attendance
    ) {
      const effectiveEventAt = overrideEventAt ?? request.eventAt
      if (effectiveEventAt) {
        const fullRecord = await prisma.attendanceRecord.findUnique({
          where: {
            employeeId_date: { employeeId: request.employeeId, date: request.date },
          },
          select: { id: true, timeIn: true, timeOut: true },
        })
        if (fullRecord) {
          const currentTime =
            request.kind === "CLOCK_IN" ? fullRecord.timeIn : fullRecord.timeOut
          const differs =
            currentTime == null ||
            currentTime.getTime() !== effectiveEventAt.getTime()
          if (differs) {
            await this.overrideAttendanceTimes({
              attendanceRecordId: fullRecord.id,
              editorId: reviewerId,
              editorRole: "SUPERVISOR",
              source: "APPROVE_OVERRIDE",
              ...(request.kind === "CLOCK_IN"
                ? { timeIn: effectiveEventAt }
                : { timeOut: effectiveEventAt }),
              reason: notes ?? null,
            })
          }
        }
      }
    }

    // When an OT request reaches APPROVED and the effective payout method
    // is TIME_BANK, credit the OT minutes to their time balance. Snapshot
    // wins if present (locks treatment); otherwise fall back to the
    // employee's current policy setting.
    if (finalStatus === "APPROVED" && request.kind === "OT") {
      const profile = await prisma.employeeProfile.findFirst({
        where: { userId: request.employeeId },
        select: {
          id: true,
          policy: { select: { otEnabled: true, otMethod: true } },
        },
      })
      const effectivePayout =
        request.otPayoutMethod ??
        (profile?.policy?.otEnabled && profile.policy.otMethod === "TIME_BANK"
          ? "TIME_BANK"
          : "CASH")
      if (effectivePayout === "TIME_BANK" && profile) {
        const otMinutes =
          request.otStartAt && request.otEndAt
            ? Math.round(
                (request.otEndAt.getTime() - request.otStartAt.getTime()) / 60_000,
              )
            : 0
        if (otMinutes > 0) {
          await prisma.employeeProfile.updateMany({
            where: { id: profile.id },
            data: { otTimeBalanceMin: { increment: otMinutes } },
          })
        }
      }
    }

    return {
      employeeUserId: request.employeeId,
      kind: request.kind,
      finalStatus,
      nextApproverIds,
      peerApproverIds,
    }
  },

  // ── Admin ─────────────────────────────────────────────────────────────

  async getAllPendingApprovals(
    orgId?: string | null,
    options?: { policyIdScope?: string[] | null },
  ): Promise<ApprovalRequestView[]> {
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const prisma = getClient()
    const employeeFilter = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(policyIdScope && policyIdScope.length > 0
        ? { employeeProfiles: { some: { policyId: { in: policyIdScope } } } }
        : {}),
    }
    const where =
      orgId || policyIdScope
        ? { status: "PENDING" as const, employee: employeeFilter }
        : { status: "PENDING" as const }
    const records = await prisma.approvalRequest.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      include: {
        employee: { select: { name: true } },
        otAttachments: { orderBy: { createdAt: "asc" } },
      },
      take: 200,
    })
    const withContext = await attachChainContext(
      records.map((r) => ({
        ...approvalToView(r),
        attachments: r.otAttachments.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          fileUrl: a.fileUrl,
          mimeType: a.mimeType,
          uploadedAt: a.createdAt.toISOString(),
          kind: a.kind as "JUSTIFICATION" | "EVIDENCE",
        })),
      })),
    )
    return backfillLateMinutes(withContext, prisma)
  },

  async getOrgOverview(
    orgId: string | null,
    projectId?: string | null,
    options?: { policyIdScope?: string[] | null },
  ): Promise<AdminOrgOverview> {
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      // Empty policy scope = admin sees no employees → return an empty
      // overview shape rather than a noisy zero-headcount one.
      return {
        headcount: 0,
        presentToday: 0,
        lateToday: 0,
        onLeaveToday: 0,
        pendingApprovals: 0,
        byProject: [],
      }
    }
    const prisma = getClient()
    const tz = await this.getOrgTimezone(orgId)
    const today = startOfLocalDay(new Date(), tz)

    // When a project filter is set, scope every count/list to employees who
    // are assigned to that project (via EmployeeProjectAssignment) and to
    // attendance records actually clocked into that project.
    let employeeIds: string[] | null = null
    if (projectId && orgId) {
      employeeIds = await this.getEmployeeIdsForProject(orgId, projectId)
    }

    const policyEmployeeFilter =
      policyIdScope && policyIdScope.length > 0
        ? { employeeProfiles: { some: { policyId: { in: policyIdScope } } } }
        : {}

    const userWhere = orgId ? { organizationId: orgId } : {}
    const headcount = await prisma.user.count({
      where: {
        ...userWhere,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
        ...policyEmployeeFilter,
      },
    })

    const todayRecords = await prisma.attendanceRecord.findMany({
      where: {
        date: today,
        ...(orgId || policyIdScope
          ? {
              employee: {
                ...(orgId ? { organizationId: orgId } : {}),
                ...policyEmployeeFilter,
              },
            }
          : {}),
        ...(projectId ? { projectId } : {}),
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      },
      include: orgId ? undefined : { employee: { select: { organizationId: true } } },
    })

    const presentToday = todayRecords.filter(
      (r) => r.status === "ON_TIME" || r.status === "LATE" || r.status === "CLOCKED_IN",
    ).length
    const lateToday = todayRecords.filter((r) => r.status === "LATE").length
    const onLeaveToday = todayRecords.filter((r) => r.status === "ON_LEAVE").length

    const pendingApprovals = await prisma.approvalRequest.count({
      where: {
        status: "PENDING",
        ...(orgId ? { employee: { organizationId: orgId } } : {}),
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      },
    })

    // Group present/late counts by project (best-effort — uses the project string on AttendanceRecord)
    const byProjectMap = new Map<string, { headcount: number; present: number; late: number }>()
    for (const r of todayRecords) {
      const key = r.project ?? "Unassigned"
      const slot = byProjectMap.get(key) ?? { headcount: 0, present: 0, late: 0 }
      slot.headcount += 1
      if (r.status === "ON_TIME" || r.status === "LATE" || r.status === "CLOCKED_IN") {
        slot.present += 1
      }
      if (r.status === "LATE") slot.late += 1
      byProjectMap.set(key, slot)
    }

    return {
      headcount,
      presentToday,
      lateToday,
      onLeaveToday,
      pendingApprovals,
      byProject: Array.from(byProjectMap.entries())
        .map(([project, v]) => ({
          project,
          headcount: v.headcount,
          presentToday: v.present,
          lateToday: v.late,
        }))
        .sort((a, b) => b.headcount - a.headcount),
    }
  },

  async getAggregateStats(
    from: Date,
    to: Date,
    orgId: string | null,
    projectId?: string | null,
    options?: { policyIdScope?: string[] | null },
  ): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      return {
        totalAttendanceRecords: 0,
        totalLate: 0,
        totalMissing: 0,
        totalOnLeave: 0,
        pendingOT: 0,
      }
    }
    const prisma = getClient()
    let employeeIds: string[] | null = null
    if (projectId && orgId) {
      employeeIds = await this.getEmployeeIdsForProject(orgId, projectId)
    }
    const policyEmployeeFilter =
      policyIdScope && policyIdScope.length > 0
        ? { employeeProfiles: { some: { policyId: { in: policyIdScope } } } }
        : {}
    const employeeFilter = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...policyEmployeeFilter,
    }
    const hasEmployeeFilter = orgId || policyIdScope
    const baseWhere = {
      date: { gte: startOfDay(from), lte: endOfDay(to) },
      ...(hasEmployeeFilter ? { employee: employeeFilter } : {}),
      ...(projectId ? { projectId } : {}),
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
    }
    const [totalAttendanceRecords, totalLate, totalMissing, totalOnLeave, pendingOT] =
      await Promise.all([
        prisma.attendanceRecord.count({ where: baseWhere }),
        prisma.attendanceRecord.count({ where: { ...baseWhere, status: "LATE" } }),
        prisma.attendanceRecord.count({ where: { ...baseWhere, status: "MISSING" } }),
        prisma.attendanceRecord.count({ where: { ...baseWhere, status: "ON_LEAVE" } }),
        prisma.approvalRequest.count({
          where: {
            kind: "OT",
            status: "PENDING",
            ...(hasEmployeeFilter ? { employee: employeeFilter } : {}),
            ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
          },
        }),
      ])
    return {
      totalAttendanceRecords,
      totalLate,
      totalMissing,
      totalOnLeave,
      pendingOT,
    }
  },

  /**
   * Roll-call snapshot for today. Splits the active workforce into:
   *   - late      → AttendanceRecord.status = LATE
   *   - onLeave   → AttendanceRecord.status = ON_LEAVE
   *   - notClockedIn → no record OR record.status = MISSING (and not on leave)
   */
  async getHoursSummary(args: {
    orgId?: string | null
    employeeId?: string
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    from: Date
    to: Date
    policyIdScope?: string[] | null
  }): Promise<{
    totals: HoursBuckets & { expectedMin: number }
    employees: Array<{
      employeeId: string
      name: string
      email: string
      initials: string
      /// False when the employee's policy has `otEnabled: false`. The
      /// summary card / table render "—" in OT / Rest day / PH columns
      /// for these rows; their minutes are folded into Normal.
      otEnabled: boolean
      buckets: HoursBuckets & { expectedMin: number }
    }>
  }> {
    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      return {
        totals: { ...EMPTY_BUCKETS, expectedMin: 0 },
        employees: [],
      }
    }
    const prisma = getClient()
    const from = startOfDay(args.from)
    const to = endOfDay(args.to)

    const employeeWhere: Record<string, unknown> = {
      role: { in: ["EMPLOYEE", "SUPERVISOR"] },
    }
    if (args.employeeId) {
      employeeWhere.id = args.employeeId
    } else if (args.orgId) {
      employeeWhere.organizationId = args.orgId
    }
    if (policyIdScope && policyIdScope.length > 0) {
      employeeWhere.employeeProfile = { policyId: { in: policyIdScope } }
    }
    if (args.orgId && (args.projectId || args.teamId || args.q)) {
      const ids = await this.resolveScopedEmployeeIds(args.orgId, {
        projectId: args.projectId,
        teamId: args.teamId,
        q: args.q,
      })
      if (ids && ids.length === 0) {
        return {
          totals: { ...EMPTY_BUCKETS, expectedMin: 0 },
          employees: [],
        }
      }
      if (ids) {
        employeeWhere.id = args.employeeId
          ? args.employeeId
          : { in: ids }
      }
    }

    const employees = await prisma.user.findMany({
      where: employeeWhere,
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, email: true, organizationId: true },
    })
    if (employees.length === 0) {
      return {
        totals: { ...EMPTY_BUCKETS, expectedMin: 0 },
        employees: [],
      }
    }
    const employeeIds = employees.map((e) => e.id)

    const orgIds = Array.from(
      new Set(
        [args.orgId, ...employees.map((e) => e.organizationId)].filter(
          (x): x is string => Boolean(x),
        ),
      ),
    )
    const orgs =
      orgIds.length === 0
        ? []
        : await prisma.organization.findMany({
            where: { id: { in: orgIds } },
            select: {
              id: true,
              workingHoursStart: true,
              workingHoursEnd: true,
            },
          })
    // Per-employee OT threshold + OT-enabled flag — both come from the
    // employee's policy. `otEnabled = false` means OT/Rest day/PH
    // classification is N/A for this employee; the per-row buckets get
    // folded into Normal before the UI renders, and Total Worked still
    // reflects actual time clocked in.
    const policyThresholds =
      employeeIds.length === 0
        ? []
        : await prisma.employeeProfile.findMany({
            where: { userId: { in: employeeIds } },
            select: {
              userId: true,
              policy: {
                select: { otDailyThresholdMinutes: true, otEnabled: true },
              },
            },
          })
    const employeeThresholdMin = new Map(
      policyThresholds
        .filter((p) => p.policy !== null)
        .map((p) => [p.userId, p.policy!.otDailyThresholdMinutes]),
    )
    const employeeOtEnabled = new Map(
      policyThresholds
        .filter((p) => p.policy !== null)
        .map((p) => [p.userId, p.policy!.otEnabled]),
    )
    const orgScheduleById = new Map(
      orgs.map((o) => [
        o.id,
        { start: o.workingHoursStart, end: o.workingHoursEnd },
      ]),
    )
    const employeeOrgId = new Map(employees.map((e) => [e.id, e.organizationId]))

    // Resolve each employee's "primary" schedule (from their first
    // project assignment) so we can compute expected hours even when
    // they have zero attendance records in the range. Falls back to
    // org-level working hours and Mon-Fri / 60-min lunch defaults.
    const profilesWithProjects = await prisma.user.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true,
        employeeProfiles: {
          select: {
            projectAssignments: {
              select: {
                project: {
                  select: {
                    workingHoursStart: true,
                    workingHoursEnd: true,
                    workingDays: true,
                    lunchBreakMinutes: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    })
    type EmpSchedule = {
      workingDays: Set<number>
      standardDailyMin: number
    }
    const scheduleByEmployee = new Map<string, EmpSchedule>()
    for (const u of profilesWithProjects) {
      const proj = u.employeeProfiles[0]?.projectAssignments?.[0]?.project ?? null
      const orgId = employeeOrgId.get(u.id) ?? null
      const orgSched = orgId ? orgScheduleById.get(orgId) : null
      const start = proj?.workingHoursStart ?? orgSched?.start ?? "09:00"
      const end = proj?.workingHoursEnd ?? orgSched?.end ?? "18:00"
      const lunch = proj?.lunchBreakMinutes ?? DEFAULT_LUNCH_BREAK_MIN
      scheduleByEmployee.set(u.id, {
        workingDays: parseWorkingDays(proj?.workingDays ?? null),
        standardDailyMin: standardDailyMinutesFrom(start, end, lunch),
      })
    }
    const otThresholdFor = (employeeId: string): number => {
      return employeeThresholdMin.get(employeeId) ?? 8 * 60
    }

    const records = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { gte: from, lte: to },
        durationMin: { not: null },
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
      select: {
        employeeId: true,
        date: true,
        durationMin: true,
        projectId: true,
        projectRef: {
          select: {
            id: true,
            workingHoursStart: true,
            workingHoursEnd: true,
            workingDays: true,
            lunchBreakMinutes: true,
          },
        },
      },
    })

    const projectIds = Array.from(
      new Set(records.map((r) => r.projectId).filter((x): x is string => Boolean(x))),
    )
    const holidays =
      projectIds.length === 0
        ? []
        : await prisma.projectHoliday.findMany({
            where: {
              projectId: { in: projectIds },
              date: { gte: from, lte: to },
            },
            select: { projectId: true, date: true },
          })
    const holidayKey = (projectId: string, date: Date) =>
      `${projectId}|${startOfDay(date).toISOString()}`
    const holidaySet = new Set(
      holidays.map((h) => holidayKey(h.projectId, h.date)),
    )

    // Fetch ALL OT requests in the period (not just APPROVED) so we can
    // surface per-day approval status in the buckets below — the hours
    // summary panel renders Overtime as Approved + Pending + Rejected,
    // not a single opaque "Overtime" total.
    const otRequests = await prisma.approvalRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        kind: "OT",
        date: { gte: from, lte: to },
      },
      select: { employeeId: true, date: true, status: true, otStartAt: true, otEndAt: true },
    })
    const otKey = (employeeId: string, date: Date) =>
      `${employeeId}|${startOfDay(date).toISOString()}`
    const otStatusByKey = new Map<
      string,
      "APPROVED" | "PENDING" | "REJECTED"
    >()
    for (const r of otRequests) {
      // Multiple OT rows on the same day shouldn't happen by design, but
      // prefer APPROVED over PENDING over REJECTED if it ever does.
      const k = otKey(r.employeeId, r.date)
      const prev = otStatusByKey.get(k)
      if (
        prev === "APPROVED" ||
        (prev === "PENDING" && r.status === "REJECTED")
      ) {
        continue
      }
      otStatusByKey.set(k, r.status as "APPROVED" | "PENDING" | "REJECTED")
    }

    const perEmployee = new Map<string, HoursBuckets>()
    for (const id of employeeIds) {
      perEmployee.set(id, { ...EMPTY_BUCKETS })
    }

    for (const record of records) {
      const dur = record.durationMin ?? 0
      if (dur <= 0) continue
      const isPH = record.projectId
        ? holidaySet.has(holidayKey(record.projectId, record.date))
        : false
      const workingDays = parseWorkingDays(record.projectRef?.workingDays ?? null)
      const standardDailyMin = standardDailyMinutesFrom(
        record.projectRef?.workingHoursStart ?? null,
        record.projectRef?.workingHoursEnd ?? null,
        record.projectRef?.lunchBreakMinutes ?? null,
      )
      const otStatus = otStatusByKey.get(otKey(record.employeeId, record.date)) ?? null

      const bucket = bucketRecord({
        durationMin: dur,
        date: record.date,
        isPublicHoliday: isPH,
        workingDays,
        standardDailyMin,
        otThresholdMin: otThresholdFor(record.employeeId),
        // No longer consulted by bucketRecord's math (always-split), but
        // kept on the input shape for backwards-compat.
        hasApprovedOT: otStatus === "APPROVED",
      })

      const current = perEmployee.get(record.employeeId) ?? { ...EMPTY_BUCKETS }
      perEmployee.set(record.employeeId, addBuckets(current, bucket))
    }

    // Add OT submission minutes (from otStartAt/otEndAt) to each employee's
    // bucket. OT is submission-driven — bucketRecord no longer produces
    // otMin from clock-in duration, so these are the only source of otMin.
    for (const req of otRequests) {
      if (!req.otStartAt || !req.otEndAt) continue
      const otMin = Math.round(
        (req.otEndAt.getTime() - req.otStartAt.getTime()) / 60_000,
      )
      if (otMin <= 0) continue
      const current = perEmployee.get(req.employeeId) ?? { ...EMPTY_BUCKETS }
      const status = req.status as "APPROVED" | "PENDING" | "REJECTED"
      current.otMin += otMin
      if (status === "APPROVED") current.otApprovedMin += otMin
      else if (status === "PENDING") current.otPendingMin += otMin
      else if (status === "REJECTED") current.otRejectedMin += otMin
      perEmployee.set(req.employeeId, current)
    }

    let totals: HoursBuckets = { ...EMPTY_BUCKETS }
    let totalsExpectedMin = 0
    const rows = await Promise.all(employees.map(async (e) => {
      const raw = perEmployee.get(e.id) ?? { ...EMPTY_BUCKETS }
      // No-OT employees: collapse OT / Rest day / PH minutes into Normal
      // so the UI can render "—" in those columns without losing track of
      // the actual time worked. Total Worked (`totalMin`) is unchanged.
      const otEnabled = employeeOtEnabled.get(e.id) ?? true
      const buckets: HoursBuckets = otEnabled
        ? raw
        : {
            ...raw,
            normalMin:
              raw.normalMin + raw.otMin + raw.restDayMin + raw.publicHolidayMin,
            otMin: 0,
            restDayMin: 0,
            publicHolidayMin: 0,
            otApprovedMin: 0,
            otPendingMin: 0,
            otRejectedMin: 0,
          }
      totals = addBuckets(totals, buckets)
      const sched = scheduleByEmployee.get(e.id)
      const scheduledMin = sched
        ? expectedMinutesForRange({
            from,
            to,
            workingDays: sched.workingDays,
            standardDailyMin: sched.standardDailyMin,
          })
        : 0
      const profileId = await employeeProfileIdForUserId(e.id)
      const leaveDeduction =
        sched && profileId
          ? await paidLeaveMinutes(profileId, from, to, sched.standardDailyMin)
          : 0
      const expectedMin = Math.max(0, scheduledMin - leaveDeduction)
      totalsExpectedMin += expectedMin
      return {
        employeeId: e.id,
        name: e.name,
        email: e.email,
        initials: buildInitials(e.name),
        otEnabled,
        buckets: { ...buckets, expectedMin },
      }
    }))

    return {
      totals: { ...totals, expectedMin: totalsExpectedMin },
      employees: rows,
    }
  },

  /// Returns actual worked minutes and expected (minimum) minutes for an
  /// inclusive [from, to] date range. The schedule is resolved from the
  /// employee's first project assignment (falling back to org defaults).
  /// Approved PAID leave is subtracted from the expected total (full-day =
  /// standardDailyMin, half-day = half); approved UNPAID leave and public
  /// holidays are not.
  async getEmployeeRangeProgress(args: {
    employeeId: string
    from: Date
    to: Date
  }): Promise<{ actualMin: number; expectedMin: number }> {
    const prisma = getClient()
    const from = startOfDay(args.from)
    const to = endOfDay(args.to)

    const user = await prisma.user.findUnique({
      where: { id: args.employeeId },
      select: {
        organizationId: true,
        organization: {
          select: { workingHoursStart: true, workingHoursEnd: true },
        },
        employeeProfiles: {
          select: {
            projectAssignments: {
              select: {
                project: {
                  select: {
                    workingHoursStart: true,
                    workingHoursEnd: true,
                    workingDays: true,
                    lunchBreakMinutes: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    })
    if (!user) return { actualMin: 0, expectedMin: 0 }

    const proj = user.employeeProfiles[0]?.projectAssignments?.[0]?.project ?? null
    const start = proj?.workingHoursStart ?? user.organization?.workingHoursStart ?? "09:00"
    const end = proj?.workingHoursEnd ?? user.organization?.workingHoursEnd ?? "18:00"
    const lunch = proj?.lunchBreakMinutes ?? DEFAULT_LUNCH_BREAK_MIN
    const workingDays = parseWorkingDays(proj?.workingDays ?? null)
    const standardDailyMin = standardDailyMinutesFrom(start, end, lunch)

    const scheduledMin = expectedMinutesForRange({
      from,
      to,
      workingDays,
      standardDailyMin,
    })

    const profileId = await employeeProfileIdForUserId(args.employeeId)
    const leaveDeduction = profileId
      ? await paidLeaveMinutes(profileId, from, to, standardDailyMin)
      : 0
    const expectedMin = Math.max(0, scheduledMin - leaveDeduction)

    const records = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: args.employeeId,
        date: { gte: from, lte: to },
        durationMin: { not: null },
      },
      select: { durationMin: true },
    })
    const actualMin = records.reduce(
      (sum, r) => sum + Math.max(0, r.durationMin ?? 0),
      0,
    )

    return { actualMin, expectedMin }
  },

  /**
   * Returns IDs of EMPLOYEE/SUPERVISOR users in `orgId` who are assigned to
   * `projectId` via EmployeeProjectAssignment. Used to scope all attendance
   * queries when an admin filters the overview by project.
   */
  async getEmployeeIdsForProject(
    orgId: string,
    projectId: string,
  ): Promise<string[]> {
    const prisma = getClient()
    const users = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: {
          some: { projectAssignments: { some: { projectId } } },
        },
      },
      select: { id: true },
    })
    return users.map((u) => u.id)
  },

  /**
   * Resolves the set of EMPLOYEE/SUPERVISOR user ids in an org that match
   * the optional project / team / employee-name-search filters. Returns
   * `null` when no filter is supplied so callers can skip the
   * `id IN (...)` narrowing entirely.
   */
  async resolveScopedEmployeeIds(
    orgId: string,
    filters: {
      projectId?: string | null
      teamId?: string | null
      q?: string | null
    },
  ): Promise<string[] | null> {
    const projectId = filters.projectId || null
    const teamId = filters.teamId || null
    const q = filters.q?.trim() || null
    if (!projectId && !teamId && !q) return null

    const prisma = getClient()
    const conditions: Record<string, unknown>[] = []
    if (projectId) {
      conditions.push({
        employeeProfiles: { some: { projectAssignments: { some: { projectId } } } },
      })
    }
    if (teamId) {
      conditions.push({
        employeeProfiles: { some: { teamMemberships: { some: { teamId } } } },
      })
    }
    if (q) {
      conditions.push({
        OR: [
          { name: { contains: q } },
          { email: { contains: q } },
        ],
      })
    }

    const users = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        AND: conditions,
      },
      select: { id: true },
    })
    return users.map((u) => u.id)
  },

  /**
   * Returns reviewed approvals (APPROVED + REJECTED) for the org over a
   * date range, with reviewer + employee names and a delta (in minutes)
   * between the original event time and when the supervisor reviewed it.
   * Optionally filtered to a single project.
   */
  /**
   * Aggregates approval activity by reviewer for the supervisor-performance
   * card. Returns one row per supervisor who reviewed at least one approval
   * in the date range, with counts of slow decisions (any single decision
   * whose latency from `eventAt` to `reviewedAt` exceeds `slaMinutes`) and
   * rejections, plus totals and average latency.
   */
  async getSupervisorPerformance(args: {
    orgId: string | null
    from: Date
    to: Date
    slaMinutes: number
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    policyIdScope?: string[] | null
  }): Promise<
    Array<{
      reviewerId: string
      reviewerName: string
      totalDecisions: number
      approvedCount: number
      rejectedCount: number
      slowApprovalCount: number
      avgDelayMinutes: number | null
      maxDelayMinutes: number | null
    }>
  > {
    const prisma = getClient()
    const from = startOfDay(args.from)
    const to = endOfDay(args.to)

    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const where: Record<string, unknown> = {
      status: { in: ["APPROVED", "REJECTED"] },
      reviewedAt: { gte: from, lte: to },
      reviewerId: { not: null },
    }
    const employeeFilter: Record<string, unknown> = {}
    if (args.orgId) employeeFilter.organizationId = args.orgId
    if (policyIdScope && policyIdScope.length > 0) {
      employeeFilter.employeeProfile = { policyId: { in: policyIdScope } }
    }
    if (Object.keys(employeeFilter).length > 0) {
      where.employee = employeeFilter
    }
    if (args.orgId && (args.projectId || args.teamId || args.q)) {
      const empIds = await this.resolveScopedEmployeeIds(args.orgId, {
        projectId: args.projectId,
        teamId: args.teamId,
        q: args.q,
      })
      if (empIds && empIds.length === 0) return []
      if (empIds) where.employeeId = { in: empIds }
    }

    const rows = await prisma.approvalRequest.findMany({
      where,
      select: {
        reviewerId: true,
        status: true,
        eventAt: true,
        reviewedAt: true,
        reviewer: { select: { name: true } },
      },
    })

    type Bucket = {
      reviewerId: string
      reviewerName: string
      totalDecisions: number
      approvedCount: number
      rejectedCount: number
      slowApprovalCount: number
      delaySum: number
      delayCount: number
      maxDelayMinutes: number | null
    }
    const byReviewer = new Map<string, Bucket>()
    for (const r of rows) {
      if (!r.reviewerId || !r.reviewedAt) continue
      const existing =
        byReviewer.get(r.reviewerId) ??
        ({
          reviewerId: r.reviewerId,
          reviewerName: r.reviewer?.name ?? r.reviewerId,
          totalDecisions: 0,
          approvedCount: 0,
          rejectedCount: 0,
          slowApprovalCount: 0,
          delaySum: 0,
          delayCount: 0,
          maxDelayMinutes: null,
        } satisfies Bucket)

      existing.totalDecisions += 1
      if (r.status === "APPROVED") existing.approvedCount += 1
      if (r.status === "REJECTED") existing.rejectedCount += 1

      if (r.eventAt) {
        const delay = Math.round(
          (r.reviewedAt.getTime() - r.eventAt.getTime()) / 60000,
        )
        existing.delaySum += delay
        existing.delayCount += 1
        existing.maxDelayMinutes =
          existing.maxDelayMinutes == null
            ? delay
            : Math.max(existing.maxDelayMinutes, delay)
        if (r.status === "APPROVED" && delay > args.slaMinutes) {
          existing.slowApprovalCount += 1
        }
      }
      byReviewer.set(r.reviewerId, existing)
    }

    return Array.from(byReviewer.values())
      .map((b) => ({
        reviewerId: b.reviewerId,
        reviewerName: b.reviewerName,
        totalDecisions: b.totalDecisions,
        approvedCount: b.approvedCount,
        rejectedCount: b.rejectedCount,
        slowApprovalCount: b.slowApprovalCount,
        avgDelayMinutes:
          b.delayCount > 0 ? Math.round(b.delaySum / b.delayCount) : null,
        maxDelayMinutes: b.maxDelayMinutes,
      }))
      .sort(
        (a, b) =>
          b.slowApprovalCount - a.slowApprovalCount ||
          b.rejectedCount - a.rejectedCount ||
          (b.avgDelayMinutes ?? 0) - (a.avgDelayMinutes ?? 0),
      )
  },

  async getApprovalAuditLog(args: {
    orgId: string | null
    from: Date
    to: Date
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    statuses?: Array<"APPROVED" | "REJECTED" | "PENDING">
    policyIdScope?: string[] | null
  }): Promise<
    Array<{
      id: string
      kind: ApprovalKind
      status: "APPROVED" | "REJECTED" | "PENDING"
      employeeId: string
      employeeName: string
      reviewerId: string | null
      reviewerName: string | null
      eventAt: string | null
      reviewedAt: string | null
      delayMinutes: number | null
      project: string | null
      title: string
      chainHistory: ChainHistoryEntry[] | null
      selfieAttendanceRecordId: string | null
      overrideAt: string | null
      overrideReason: string | null
      otStartAt: string | null
      otEndAt: string | null
    }>
  > {
    const prisma = getClient()
    const from = startOfDay(args.from)
    const to = endOfDay(args.to)
    const statuses = args.statuses ?? ["APPROVED", "REJECTED"]
    const includesPending = statuses.includes("PENDING")

    const where: Record<string, unknown> = {
      status: { in: statuses },
    }
    if (includesPending) {
      // For PENDING rows reviewedAt is null; filter by submittedAt instead
      // and accept either condition for mixed queries.
      where.OR = [
        { reviewedAt: { gte: from, lte: to } },
        { status: "PENDING", submittedAt: { gte: from, lte: to } },
      ]
    } else {
      where.reviewedAt = { gte: from, lte: to }
    }
    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const auditEmployeeFilter: Record<string, unknown> = {}
    if (args.orgId) auditEmployeeFilter.organizationId = args.orgId
    if (policyIdScope && policyIdScope.length > 0) {
      auditEmployeeFilter.employeeProfile = { policyId: { in: policyIdScope } }
    }
    if (Object.keys(auditEmployeeFilter).length > 0) {
      where.employee = auditEmployeeFilter
    }
    if (args.orgId && (args.projectId || args.teamId || args.q)) {
      const empIds = await this.resolveScopedEmployeeIds(args.orgId, {
        projectId: args.projectId,
        teamId: args.teamId,
        q: args.q,
      })
      if (empIds && empIds.length === 0) return []
      if (empIds) where.employeeId = { in: empIds }
    }

    const rows = await prisma.approvalRequest.findMany({
      where,
      orderBy: includesPending
        ? [{ reviewedAt: "desc" }, { submittedAt: "desc" }]
        : { reviewedAt: "desc" },
      take: 500,
      include: {
        employee: { select: { name: true } },
        reviewer: { select: { name: true } },
      },
    })

    // Look up supervisor time overrides applied during approval. Each
    // row keyed by `${employeeId}|${date}|${reviewerId}` so we can pair
    // it back to the matching approval below.
    let overrideByKey = new Map<
      string,
      { at: Date | null; reason: string | null }
    >()
    const clockOverrideRows = rows.filter(
      (r) =>
        r.reviewerId &&
        (r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT") &&
        r.status === "APPROVED",
    )
    if (clockOverrideRows.length > 0) {
      const logs = await prisma.attendanceEditLog.findMany({
        where: {
          source: "APPROVE_OVERRIDE",
          editedById: {
            in: Array.from(
              new Set(
                clockOverrideRows
                  .map((r) => r.reviewerId)
                  .filter((id): id is string => Boolean(id)),
              ),
            ),
          },
          attendanceRecord: {
            OR: clockOverrideRows.map((r) => ({
              employeeId: r.employeeId,
              date: startOfDay(r.date),
            })),
          },
        },
        orderBy: { createdAt: "desc" },
        include: {
          attendanceRecord: {
            select: { employeeId: true, date: true },
          },
        },
      })
      // For each (employeeId,date,reviewerId,kind) keep the most recent
      // override log row. We pick nextTimeIn for CLOCK_IN approvals and
      // nextTimeOut for CLOCK_OUT approvals when present.
      overrideByKey = new Map()
      for (const log of logs) {
        const empId = log.attendanceRecord.employeeId
        const dateKey = log.attendanceRecord.date.toISOString().slice(0, 10)
        const reviewerId = log.editedById
        // Two passes — try CLOCK_IN slot first, then CLOCK_OUT slot.
        for (const kind of ["CLOCK_IN", "CLOCK_OUT"] as const) {
          const key = `${empId}|${dateKey}|${reviewerId}|${kind}`
          if (overrideByKey.has(key)) continue
          const at =
            kind === "CLOCK_IN" ? log.nextTimeIn : log.nextTimeOut
          if (!at) continue
          overrideByKey.set(key, { at, reason: log.reason })
        }
      }
    }

    // Look up selfie attachments for CLOCK_IN and CLOCK_OUT rows in one query.
    const selfieRowKeys = new Map<string, { employeeId: string; date: Date }>()
    const clockInRowIds: string[] = []
    for (const r of rows) {
      if (r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT") {
        const key = `${r.employeeId}|${r.date.toISOString().slice(0, 10)}`
        if (!selfieRowKeys.has(key)) {
          selfieRowKeys.set(key, { employeeId: r.employeeId, date: r.date })
        }
        if (r.kind === "CLOCK_IN") clockInRowIds.push(r.id)
      }
    }
    let selfieByKey = new Map<string, string>()         // dateKey → recordId (clock-in fallback)
    let clockOutSelfieByKey = new Map<string, string>() // dateKey → recordId (clock-out)
    if (selfieRowKeys.size > 0) {
      const records = await prisma.attendanceRecord.findMany({
        where: {
          OR: Array.from(selfieRowKeys.values()).map((r) => ({
            employeeId: r.employeeId,
            date: startOfDay(r.date),
          })),
        },
        select: {
          id: true,
          employeeId: true,
          date: true,
          xeroSelfieFileId: true,
          clockOutXeroSelfieFileId: true,
        },
      })
      for (const rec of records) {
        const key = `${rec.employeeId}|${rec.date.toISOString().slice(0, 10)}`
        if (rec.xeroSelfieFileId) selfieByKey.set(key, rec.id)
        if (rec.clockOutXeroSelfieFileId) clockOutSelfieByKey.set(key, rec.id)
      }
    }
    // Per-session selfie map: approvalId → sessionId. Avoids the day-level
    // record collision on multi-session days where the record-level
    // xeroSelfieFileId is overwritten by successive clock-ins.
    const sessionByApprovalId = new Map<string, string>()
    if (clockInRowIds.length > 0) {
      const sessions = await prisma.attendanceSession.findMany({
        where: {
          clockInApprovalRequestId: { in: clockInRowIds },
          xeroSelfieFileId: { not: null },
        },
        select: { id: true, clockInApprovalRequestId: true },
      })
      for (const s of sessions) {
        if (s.clockInApprovalRequestId) {
          sessionByApprovalId.set(s.clockInApprovalRequestId, s.id)
        }
      }
    }

    return rows.map((r) => {
      const reviewedAt = r.reviewedAt
      const delayMinutes =
        r.eventAt && reviewedAt
          ? Math.round((reviewedAt.getTime() - r.eventAt.getTime()) / 60000)
          : null
      const dateOnly = r.date.toISOString().slice(0, 10)
      const dateKey = `${r.employeeId}|${dateOnly}`
      const overrideKey =
        r.reviewerId && (r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT")
          ? `${r.employeeId}|${dateOnly}|${r.reviewerId}|${r.kind}`
          : null
      const override = overrideKey ? overrideByKey.get(overrideKey) : undefined
      const selfieAttendanceRecordId =
        r.kind === "CLOCK_IN"
          ? (sessionByApprovalId.get(r.id) ?? selfieByKey.get(dateKey) ?? null)
          : r.kind === "CLOCK_OUT"
            ? clockOutSelfieByKey.get(dateKey) ?? null
            : null
      return {
        id: r.id,
        kind: r.kind as ApprovalKind,
        status: r.status as "APPROVED" | "REJECTED" | "PENDING",
        employeeId: r.employeeId,
        employeeName: r.employee?.name ?? r.employeeId,
        reviewerId: r.reviewerId,
        reviewerName: r.reviewer?.name ?? null,
        eventAt: r.eventAt?.toISOString() ?? null,
        reviewedAt: reviewedAt ? reviewedAt.toISOString() : null,
        delayMinutes,
        project: r.project,
        title: r.title,
        chainHistory: parseChainHistory(r.chainHistory),
        selfieAttendanceRecordId,
        overrideAt: override?.at ? override.at.toISOString() : null,
        overrideReason: override?.reason ?? null,
        otStartAt: r.otStartAt?.toISOString() ?? null,
        otEndAt: r.otEndAt?.toISOString() ?? null,
      }
    })
  },

  async getOtSubmissionsForOrg(args: {
    orgId: string
    from: Date
    to: Date
    statuses?: Array<"APPROVED" | "REJECTED" | "PENDING">
    policyIdScope?: string[] | null
  }): Promise<
    Array<{
      id: string
      employeeId: string
      employeeName: string
      project: string | null
      date: string
      otStartAt: string | null
      otEndAt: string | null
      status: "PENDING" | "APPROVED" | "REJECTED"
      detail: string
      submittedAt: string
      reviewerName: string | null
      reviewedAt: string | null
      attachments: { id: string; fileName: string; fileUrl: string; mimeType: string; uploadedAt: string; kind: "JUSTIFICATION" | "EVIDENCE" }[]
    }>
  > {
    const prisma = getClient()
    const statuses = args.statuses ?? ["PENDING", "APPROVED", "REJECTED"]
    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []

    const employeeFilter: Record<string, unknown> = { organizationId: args.orgId }
    if (policyIdScope && policyIdScope.length > 0) {
      employeeFilter.employeeProfile = { policyId: { in: policyIdScope } }
    }

    const rows = await prisma.approvalRequest.findMany({
      where: {
        kind: "OT",
        status: { in: statuses },
        date: { gte: startOfDay(args.from), lte: endOfDay(args.to) },
        employee: employeeFilter,
      },
      orderBy: { date: "desc" },
      take: 500,
      include: {
        employee: { select: { name: true } },
        reviewer: { select: { name: true } },
        otAttachments: { orderBy: { createdAt: "asc" } },
      },
    })

    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      employeeName: r.employee?.name ?? r.employeeId,
      project: r.project,
      date: r.date.toISOString().slice(0, 10),
      otStartAt: r.otStartAt?.toISOString() ?? null,
      otEndAt: r.otEndAt?.toISOString() ?? null,
      status: r.status as "PENDING" | "APPROVED" | "REJECTED",
      detail: r.detail,
      submittedAt: r.submittedAt.toISOString(),
      reviewerName: r.reviewer?.name ?? null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      attachments: r.otAttachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileUrl: a.fileUrl,
        mimeType: a.mimeType,
        uploadedAt: a.createdAt.toISOString(),
        kind: a.kind as "JUSTIFICATION" | "EVIDENCE",
      })),
    }))
  },

  /**
   * Worked / scheduled / paid-leave minutes per employee profile for a
   * payroll period. Used by the payroll run service to default the HRS
   * proration figures.
   *
   * - `workedMin`  — summed `durationMin` of all attendance records in
   *   the calendar month (records only exist within employment, so no
   *   clipping needed for the sum).
   * - `scheduledMin` — `expectedMinutesForRange` over the **effective
   *   employment window** (month clipped to join/leave dates), so a
   *   mid-month joiner/leaver gets a smaller target.
   * - `paidLeaveMin` — approved PAID leave inside the same window
   *   (unpaid leave excluded by `paidLeaveMinutes`).
   *
   * Keyed by `employeeProfileId`. Profiles with no attendance config
   * still get an entry (zeros) so callers can rely on the key existing.
   */
  async getPayrollHoursForProfiles(input: {
    organizationId: string
    periodYear: number
    periodMonth: number
    employees: Array<{
      employeeProfileId: string
      joinDate: string | null
      leaveDate: string | null
    }>
  }): Promise<
    Map<string, { workedMin: number; scheduledMin: number; paidLeaveMin: number }>
  > {
    const out = new Map<
      string,
      { workedMin: number; scheduledMin: number; paidLeaveMin: number }
    >()
    const prisma = getClient()
    if (!prisma || input.employees.length === 0) return out

    const monthFrom = startOfDay(
      new Date(Date.UTC(input.periodYear, input.periodMonth - 1, 1)),
    )
    const monthTo = endOfDay(
      new Date(Date.UTC(input.periodYear, input.periodMonth, 0)),
    )

    const profileIds = input.employees.map((e) => e.employeeProfileId)
    const [org, profiles] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: input.organizationId },
        select: { workingHoursStart: true, workingHoursEnd: true },
      }),
      prisma.employeeProfile.findMany({
        where: { id: { in: profileIds } },
        select: {
          id: true,
          userId: true,
          projectAssignments: {
            select: {
              project: {
                select: {
                  workingHoursStart: true,
                  workingHoursEnd: true,
                  lunchBreakMinutes: true,
                  workingDays: true,
                },
              },
            },
            take: 1,
          },
        },
      }),
    ])

    const userIds = profiles.map((p) => p.userId).filter((id): id is string => !!id)
    const workedByUser = new Map<string, number>()
    if (userIds.length > 0) {
      const durations = await prisma.attendanceRecord.groupBy({
        by: ["employeeId"],
        where: {
          employeeId: { in: userIds },
          date: { gte: monthFrom, lte: monthTo },
          durationMin: { not: null },
        },
        _sum: { durationMin: true },
      })
      for (const d of durations) {
        workedByUser.set(d.employeeId, d._sum.durationMin ?? 0)
      }
    }

    const joinLeaveByProfile = new Map(
      input.employees.map((e) => [
        e.employeeProfileId,
        { joinDate: e.joinDate, leaveDate: e.leaveDate },
      ]),
    )

    for (const p of profiles) {
      const primary = p.projectAssignments?.[0]?.project ?? null
      const start = primary?.workingHoursStart ?? org?.workingHoursStart ?? "09:00"
      const end = primary?.workingHoursEnd ?? org?.workingHoursEnd ?? "18:00"
      const lunch = primary?.lunchBreakMinutes ?? DEFAULT_LUNCH_BREAK_MIN
      const workingDays = parseWorkingDays(primary?.workingDays ?? null)
      const standardDailyMin = standardDailyMinutesFrom(start, end, lunch)

      // Clip the expected window to the effective employment window so
      // a mid-month joiner/leaver gets a pro-rated target.
      const jl = joinLeaveByProfile.get(p.id)
      const join = jl?.joinDate ? startOfDay(new Date(jl.joinDate)) : null
      const leave = jl?.leaveDate ? endOfDay(new Date(jl.leaveDate)) : null
      const from = join && join > monthFrom ? join : monthFrom
      const to = leave && leave < monthTo ? leave : monthTo

      let scheduledMin = 0
      let paidLeaveMin = 0
      if (to >= from) {
        scheduledMin = expectedMinutesForRange({
          from,
          to,
          workingDays,
          standardDailyMin,
        })
        paidLeaveMin = await paidLeaveMinutes(p.id, from, to, standardDailyMin)
      }

      out.set(p.id, {
        workedMin: p.userId ? workedByUser.get(p.userId) ?? 0 : 0,
        scheduledMin,
        paidLeaveMin,
      })
    }

    return out
  },

  async getProjectHolidayName(projectId: string, date: Date): Promise<string | null> {
    const prisma = getClient()
    const day = startOfDay(date)
    const row = await prisma.projectHoliday.findUnique({
      where: { projectId_date: { projectId, date: day } },
      select: { name: true },
    })
    return row?.name ?? null
  },

  /**
   * The `where` behind the admin attendance History tab — date range,
   * org + policy gate, project/team/search scoping, and the status pills.
   *
   * Shared by the table and by the export's employee resolution so the
   * two can't drift: whatever the table is showing is exactly what the
   * PDF export covers. Returns null when the filter is provably empty
   * (no policy scope, no employees matched, no pill matched), which
   * callers should treat as "no results" rather than "no filter".
   */
  async buildOrgHistoryWhere(args: {
    orgId: string | null
    from: Date
    to: Date
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    statuses?: string[]
    policyIdScope?: string[] | null
  }): Promise<Record<string, unknown> | null> {
    const prisma = getClient()
    const from = startOfDay(args.from)
    const to = endOfDay(args.to)

    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return null

    const recordWhere: Record<string, unknown> = {
      date: { gte: from, lte: to },
    }

    // Build the `employee` relation filter — org + optional policy gate.
    // When the project/team/q filters resolve to a concrete id list we
    // switch to `employeeId IN (...)` instead, but we still apply the
    // policy gate inside the resolver via an outer filter on the result.
    const employeeFilter: Record<string, unknown> = {}
    if (args.orgId) employeeFilter.organizationId = args.orgId
    if (policyIdScope && policyIdScope.length > 0) {
      employeeFilter.employeeProfile = { policyId: { in: policyIdScope } }
    }

    if (args.orgId) {
      const scopedIds = await this.resolveScopedEmployeeIds(args.orgId, {
        projectId: args.projectId,
        teamId: args.teamId,
        q: args.q,
      })
      if (scopedIds !== null) {
        if (scopedIds.length === 0) return null
        recordWhere.employeeId = { in: scopedIds }
        // Still narrow by policy via the relation filter when scoped.
        if (Object.keys(employeeFilter).length > 0) {
          recordWhere.employee = employeeFilter
        }
      } else if (Object.keys(employeeFilter).length > 0) {
        recordWhere.employee = employeeFilter
      }
    }

    // Status pills. Applied last so the OT lookup can reuse the employee
    // scoping above instead of scanning every org's approvals.
    if (args.statuses && args.statuses.length > 0) {
      const clauses: Record<string, unknown>[] = []
      for (const status of args.statuses) {
        if (status === "OT") {
          const otClause = await buildOtDayClause(prisma, from, to, {
            employeeId: recordWhere.employeeId,
            employee: recordWhere.employee,
          })
          if (otClause) clauses.push(otClause)
          continue
        }
        const clause = HISTORY_STATUS_FILTERS[status]
        if (clause) clauses.push(clause)
      }
      // Empty means every selected pill matched nothing (or was
      // unrecognised). Without this the OR would be dropped and the query
      // would silently widen back to "everything".
      if (clauses.length === 0) return null
      recordWhere.OR = clauses
    }

    return recordWhere
  },

  /**
   * Employees covered by the History tab's project / team / search
   * filter — the export scope.
   *
   * Deliberately resolved from the *employee* side, not from attendance
   * records, and deliberately ignoring the status pills: the export lists
   * everyone in the selected project/team so an employee with no record
   * shows up as absent rather than vanishing. Filtering by pill would
   * turn "everyone in Project A" into "everyone in Project A who was
   * late", which is not what the report is for.
   */
  async getOrgHistoryScopeEmployees(args: {
    orgId: string | null
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    /** Further narrowing to an explicit selection (the export dialog's ticks). */
    employeeIds?: string[] | null
    policyIdScope?: string[] | null
  }): Promise<
    Array<{ id: string; name: string; jobTitle: string | null; department: string | null }>
  > {
    if (!args.orgId) return []
    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []

    const prisma = getClient()
    const scopedIds = await this.resolveScopedEmployeeIds(args.orgId, {
      projectId: args.projectId,
      teamId: args.teamId,
      q: args.q,
    })
    // null = no project/team/search filter applied → the whole org.
    if (scopedIds !== null && scopedIds.length === 0) return []

    // Intersect the filter scope with any explicit selection, so a
    // tampered id list can't reach outside the admin's filter.
    const explicit = args.employeeIds ?? null
    if (explicit !== null && explicit.length === 0) return []
    const idScope =
      explicit === null
        ? scopedIds
        : scopedIds === null
          ? explicit
          : explicit.filter((id) => scopedIds.includes(id))
    if (idScope !== null && idScope.length === 0) return []

    const users = await prisma.user.findMany({
      where: {
        organizationId: args.orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(idScope !== null ? { id: { in: idScope } } : {}),
        ...(policyIdScope && policyIdScope.length > 0
          ? { employeeProfiles: { some: { policyId: { in: policyIdScope } } } }
          : {}),
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        employeeProfiles: {
          where: { organizationId: args.orgId },
          // `department` lives on PayrollProfile, not EmployeeProfile —
          // selecting it directly here throws PrismaClientValidationError
          // and 500s the whole /admin/attendance render.
          select: {
            jobTitle: true,
            payrollProfile: { select: { department: true } },
          },
          take: 1,
        },
      },
    })

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      jobTitle: u.employeeProfiles[0]?.jobTitle ?? null,
      department: u.employeeProfiles[0]?.payrollProfile?.department ?? null,
    }))
  },

  async getOrgAttendanceHistory(args: {
    orgId: string | null
    from: Date
    to: Date
    projectId?: string | null
    teamId?: string | null
    q?: string | null
    statuses?: string[]
    page: number
    pageSize: number
    policyIdScope?: string[] | null
  }): Promise<{ rows: AttendanceRecordView[]; total: number }> {
    const prisma = getClient()
    const pageSize = args.pageSize

    const recordWhere = await this.buildOrgHistoryWhere(args)
    if (recordWhere === null) return { rows: [], total: 0 }

    const [total, records] = await Promise.all([
      prisma.attendanceRecord.count({ where: recordWhere }),
      prisma.attendanceRecord.findMany({
        where: recordWhere,
        orderBy: [{ date: "desc" }, { employee: { name: "asc" } }],
        skip: args.page * pageSize,
        take: pageSize,
        include: {
          ...BREAK_INCLUDE,
          employee: { select: { id: true, name: true, email: true } },
        },
      }),
    ])

    return { rows: records.map(attendanceToView), total }
  },

  async getAllOrganizationIds(): Promise<string[]> {
    const prisma = getClient()
    const rows = await prisma.organization.findMany({
      select: { id: true },
    })
    return rows.map((r) => r.id)
  },

  async createOtSubmission(args: {
    employeeId: string
    date: Date
    otStartAt: Date
    otEndAt: Date
    otProjectId: string | null
    notes?: string
  }): Promise<{ approvalId: string; status: "PENDING" | "APPROVED" }> {
    const prisma = getClient()
    const now = new Date()
    const [employee, employeeProfile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: args.employeeId },
        select: { role: true },
      }),
      prisma.employeeProfile.findFirst({
        where: { userId: args.employeeId },
        select: { policy: { select: { otMethod: true } } },
      }),
    ])
    const payout =
      employeeProfile?.policy?.otMethod === "TIME_BANK" ? "TIME_BANK" : "CASH"
    const autoApprove = await shouldAutoApprove({
      employeeId: args.employeeId,
      role: employee?.role,
      projectId: args.otProjectId,
      kind: "OT",
    })
    const durationMin = Math.round(
      (args.otEndAt.getTime() - args.otStartAt.getTime()) / 60_000,
    )
    const overlapping = await prisma.approvalRequest.findFirst({
      where: {
        employeeId: args.employeeId,
        kind: "OT",
        status: { in: ["PENDING", "APPROVED"] },
        otStartAt: { lt: args.otEndAt },
        otEndAt: { gt: args.otStartAt },
      },
      select: { id: true },
    })
    if (overlapping) {
      throw new Error("You already have an OT submission that overlaps this time range.")
    }

    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId: args.employeeId,
        kind: "OT",
        status: autoApprove ? "APPROVED" : "PENDING",
        date: args.date,
        eventAt: now,
        title: `OT submission • ${formatHm(durationMin)}`,
        detail: args.notes
          ? `${args.notes}`
          : `OT submitted for ${formatHm(durationMin)}.`,
        otStartAt: args.otStartAt,
        otEndAt: args.otEndAt,
        otProjectId: args.otProjectId ?? null,
        otPayoutMethod: payout,
        ...(autoApprove
          ? {
              reviewerId: args.employeeId,
              reviewedAt: now,
              reviewNotes: "Auto-approved (supervisor self-attendance)",
            }
          : {}),
      },
      select: { id: true, status: true },
    })
    if (autoApprove && payout === "TIME_BANK" && employeeProfile) {
      await prisma.employeeProfile.updateMany({
        where: { userId: args.employeeId },
        data: { otTimeBalanceMin: { increment: durationMin } },
      })
    }
    return {
      approvalId: approval.id,
      status: autoApprove ? "APPROVED" : "PENDING",
    }
  },

  async findOpenRecordsForOtWarning({
    orgId,
  }: {
    orgId: string
  }): Promise<Array<{ employeeId: string; timeIn: Date }>> {
    const prisma = getClient()
    // Return records where the employee is still clocked in and has been
    // clocked in within the last 24 hours (handles midnight-crossing shifts
    // that started before 10 pm — we don't filter by date = today).
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const rows = await prisma.attendanceRecord.findMany({
      where: {
        employee: { organizationId: orgId },
        timeIn: { not: null, gte: cutoff },
        timeOut: null,
      },
      select: {
        employeeId: true,
        timeIn: true,
      },
    })
    return rows
      .filter((r): r is { employeeId: string; timeIn: Date } => r.timeIn !== null)
  },

  // ─── Auto clock-out cron (Phase 6) ─────────────────────────────────

  /**
   * Find AttendanceSession rows that are candidates for the auto
   * clock-out cron. A row qualifies when ALL of these hold:
   *
   *   - `endedAt IS NULL` (still open — the employee never clicked
   *     Clock Out)
   *   - Their EmployeePolicy has `autoClockOutEnabled = true` and
   *     `autoClockOutAfterMin != null`
   *   - Net working minutes since `startedAt` — wall-clock elapsed
   *     minus any completed BreakSession durations — is ≥ the policy
   *     threshold
   *   - No CURRENTLY-OPEN BreakSession on the session. If they're on
   *     an open break, we skip and let the next cron cycle handle it
   *     (avoids the ambiguity of "clocked out during a break").
   *
   * For each candidate we return the pre-computed `cutoffAt` — the
   * exact instant they hit the threshold, accounting for completed
   * breaks. Setting endedAt to this (rather than "now") records the
   * true clockout time regardless of how delayed the cron was.
   *
   * `limit` caps the sweep per run so a large backlog can't blow the
   * request budget. Leftover rows come back on the next fire.
   */
  async listOpenSessionsForAutoClockOut(
    now: Date,
    limit: number,
  ): Promise<
    Array<{
      sessionId: string
      recordId: string
      employeeId: string
      organizationId: string | null
      startedAt: Date
      autoClockOutAfterMin: number
      cutoffAt: Date
      durationMin: number
    }>
  > {
    const prisma = getClient()
    const openSessions = await prisma.attendanceSession.findMany({
      where: { endedAt: null },
      select: {
        id: true,
        attendanceRecordId: true,
        startedAt: true,
        breaks: {
          select: { startedAt: true, endedAt: true },
        },
        attendanceRecord: {
          select: {
            id: true,
            employeeId: true,
            employee: {
              select: {
                organizationId: true,
                employeeProfiles: {
                  select: {
                    policy: {
                      select: {
                        autoClockOutEnabled: true,
                        autoClockOutAfterMin: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      // Ordered so the oldest open sessions get closed first on partial
      // sweeps — matters if the backlog exceeds `limit`.
      orderBy: { startedAt: "asc" },
      take: limit * 4,
    })

    const candidates: Array<{
      sessionId: string
      recordId: string
      employeeId: string
      organizationId: string | null
      startedAt: Date
      autoClockOutAfterMin: number
      cutoffAt: Date
      durationMin: number
    }> = []

    for (const s of openSessions) {
      // Find the ACTIVE policy on the employee's profile. Multi-org
      // means the same userId can appear on multiple profiles; the
      // one whose organizationId matches the User.organizationId is
      // the current active profile. Fall back to the first row.
      const profiles = s.attendanceRecord.employee?.employeeProfiles ?? []
      const activePolicy = profiles[0]?.policy ?? null
      if (!activePolicy) continue
      if (!activePolicy.autoClockOutEnabled) continue
      if (activePolicy.autoClockOutAfterMin == null) continue

      const threshold = activePolicy.autoClockOutAfterMin

      // Skip when there's an OPEN break — we can't cleanly derive a
      // cutoff, and the employee is technically not accumulating work
      // minutes right now. Next cron cycle re-inspects.
      const openBreak = s.breaks.find((b) => b.endedAt === null)
      if (openBreak) continue

      const completedBreakMin = s.breaks.reduce((sum, b) => {
        if (!b.endedAt) return sum
        const diff = Math.floor(
          (b.endedAt.getTime() - b.startedAt.getTime()) / 60_000,
        )
        return sum + Math.max(0, diff)
      }, 0)

      const wallElapsedMin = Math.floor(
        (now.getTime() - s.startedAt.getTime()) / 60_000,
      )
      const netWorkMin = wallElapsedMin - completedBreakMin
      if (netWorkMin < threshold) continue

      // Cutoff = when net work minutes first hit the threshold,
      // measured on the wall clock. That's `startedAt + threshold +
      // completedBreakMin` — pre-cutoff breaks are added back so the
      // recorded duration ends up equal to the threshold exactly.
      const cutoffAt = new Date(
        s.startedAt.getTime() + (threshold + completedBreakMin) * 60_000,
      )

      candidates.push({
        sessionId: s.id,
        recordId: s.attendanceRecordId,
        employeeId: s.attendanceRecord.employeeId,
        organizationId:
          s.attendanceRecord.employee?.organizationId ?? null,
        startedAt: s.startedAt,
        autoClockOutAfterMin: threshold,
        cutoffAt,
        durationMin: threshold,
      })

      if (candidates.length >= limit) break
    }

    return candidates
  },

  /**
   * Close ONE open AttendanceSession as an auto-clockout. Wraps the
   * two updates in a $transaction so a mid-write failure can't leave
   * the record and session in disagreement.
   *
   *   - `AttendanceSession.endedAt = cutoffAt`
   *   - `AttendanceSession.durationMin = durationMin` (= policy
   *     threshold, since we cut at the moment net work hit it)
   *   - `AttendanceSession.isAutoClockOut = true` (schema-native
   *     signal — no separate AttendanceEditLog row; the boolean is
   *     the audit trail)
   *   - `AttendanceSession.clockOutNotes` — stamp the reason so
   *     admins reviewing the record see what happened
   *   - `AttendanceRecord.timeOut = cutoffAt`, `durationMin =
   *     durationMin`, `status = "CLOCKED_OUT"` — the daily roll-up
   *     mirrors the session close
   *
   * Deliberately does NOT create an OT ApprovalRequest even if the
   * duration exceeds `otDailyThresholdMinutes`. Auto-clockouts are a
   * cleanup for "employee forgot to clock out"; treating that as an
   * OT approval would let a phantom OT slip through the queue. If
   * the employee legitimately worked past the threshold, the
   * supervisor can manually edit the session and the existing
   * override path will auto-generate the OT row properly.
   */
  async performAutoClockOut(input: {
    sessionId: string
    recordId: string
    cutoffAt: Date
    durationMin: number
  }): Promise<void> {
    const prisma = getClient()
    await prisma.$transaction([
      prisma.attendanceSession.update({
        where: { id: input.sessionId },
        data: {
          endedAt: input.cutoffAt,
          durationMin: input.durationMin,
          isAutoClockOut: true,
          clockOutNotes: "Auto-clocked-out (cron): idle past shift end",
        },
      }),
      prisma.attendanceRecord.update({
        where: { id: input.recordId },
        data: {
          timeOut: input.cutoffAt,
          durationMin: input.durationMin,
          status: "CLOCKED_OUT",
        },
      }),
    ])
  },
}
