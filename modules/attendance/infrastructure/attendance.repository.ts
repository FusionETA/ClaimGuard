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
  OTSubtype,
  RollCallPerson,
  SupervisorTeamOverview,
  TodayRollCall,
} from "@/modules/attendance/domain/models"
import {
  DEFAULT_LUNCH_BREAK_MIN,
  EMPTY_BUCKETS,
  addBuckets,
  bucketRecord,
  expectedMinutesForRange,
  formatHm,
  parseWorkingDays,
  standardDailyMinutesFrom,
  type HoursBuckets,
} from "@/modules/attendance/domain/hours-summary"
import {
  DEFAULT_TIMEZONE,
  expectedTimeOnLocalDay as expectedTimeOnLocalDayInTz,
  formatLocalHm,
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
  return views.map((v) => {
    if (v.kind !== "CLOCK_IN" && v.kind !== "CLOCK_OUT") return v
    const meta = lookup.get(`${v.employeeId}|${v.date}`)
    if (!meta) return v
    if (v.kind === "CLOCK_IN") {
      return {
        ...v,
        lateMinutes:
          v.lateMinutes != null
            ? v.lateMinutes
            : meta.lateByMin && meta.lateByMin > 0
              ? meta.lateByMin
              : v.lateMinutes,
        selfieAttendanceRecordId: meta.xeroSelfieFileId ? meta.recordId : null,
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
  otSubtype: string | null
  otPayoutMethod: string | null
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
    otSubtype: (r.otSubtype as OTSubtype | null) ?? null,
    otPayoutMethod:
      r.otPayoutMethod === "TIME_BANK" || r.otPayoutMethod === "CASH"
        ? r.otPayoutMethod
        : null,
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
  const profile = await prisma.employeeProfile.findUnique({
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
    const row = await prisma.approvalRequest.findFirst({
      where: {
        employeeId,
        date: startOfDay(day),
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
      prisma.employeeProfile.findUnique({
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

    const [records, approvedOt, profile] = await Promise.all([
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
      prisma.approvalRequest.findMany({
        where: {
          employeeId: args.employeeId,
          kind: "OT",
          status: "APPROVED",
          date: { gte: args.from, lte: args.to },
        },
        select: { date: true },
      }),
      prisma.employeeProfile.findUnique({
        where: { userId: args.employeeId },
        select: {
          policy: { select: { otDailyThresholdMinutes: true } },
        },
      }),
    ])

    if (approvedOt.length === 0) {
      return { normalOtMin: 0, restMin: 0, publicMin: 0 }
    }

    const approvedDateKeys = new Set(
      approvedOt.map((a) => a.date.toISOString().slice(0, 10)),
    )

    // Public-holiday lookup for any project the employee actually clocked
    // into in the period (a record may have null projectId on legacy rows).
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

    let normalOtMin = 0
    let restMin = 0
    let publicMin = 0
    for (const rec of records) {
      const dateKey = rec.date.toISOString().slice(0, 10)
      // Only days with an APPROVED OT request count toward payroll.
      if (!approvedDateKeys.has(dateKey)) continue

      const isPH = rec.projectId
        ? holidayKeys.has(`${rec.projectId}:${dateKey}`)
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
        // No longer consulted by bucketRecord (always-split semantics),
        // but kept for backwards-compatible call signature.
        hasApprovedOT: true,
      })
      normalOtMin += bucket.otMin
      restMin += bucket.restDayMin
      publicMin += bucket.publicHolidayMin
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
    const profile = await prisma.employeeProfile.findUnique({
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
  } | null> {
    const prisma = getClient()
    const project = await prisma.xeroProject.findUnique({
      where: { id: projectId },
      select: { name: true, latitude: true, longitude: true },
    })
    return project ?? null
  },

  async getTodayProjectId(employeeId: string): Promise<string | null> {
    const prisma = getClient()
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z")
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
  async getEmployeeProjectAssignments(employeeId: string): Promise<{
    organizationId: string | null
    assignments: Array<{
      id: string
      name: string
      status: string | null
      latitude: number | null
      longitude: number | null
      workingDays: string | null
    }>
  } | null> {
    const prisma = getClient()
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: {
        organizationId: true,
        employeeProfile: {
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
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    })
    if (!user) return null
    return {
      organizationId: user.organizationId ?? null,
      assignments: (user.employeeProfile?.projectAssignments ?? []).map(
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

  async getTodayAttendance(employeeId: string): Promise<AttendanceRecordView | null> {
    const prisma = getClient()
    const today = startOfDay(new Date())
    const r = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: today } },
      include: BREAK_INCLUDE,
    })
    return r ? attendanceToView(r) : null
  },

  async getWeekAttendance(employeeId: string): Promise<AttendanceRecordView[]> {
    const prisma = getClient()
    const now = new Date()
    const dayOfWeek = now.getUTCDay() // 0 = Sun
    const monday = startOfDay(now)
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
    const today = startOfDay(new Date())
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
      include: { employee: { select: { name: true } } },
      take: 20,
    })
    return records.map(approvalToView)
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

  // ── Clock actions (employee) ──────────────────────────────────────────

  async clockIn(
    employeeId: string,
    projectName: string,
    location?: string,
    projectId?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
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
    const today = startOfDay(now)

    const employee = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true, role: true },
    })
    const orgId = employee?.organizationId ?? null
    const [hours, tz] = await Promise.all([
      this.getWorkingHours(orgId, projectId ?? null),
      this.getOrgTimezone(orgId),
    ])
    const expected = expectedTimeOnLocalDay(now, hours.start, tz)
    const diff = diffMinutes(expected, now)
    const lateMin = diff > 0 ? diff : 0
    const earlyMin = diff < 0 ? -diff : 0
    const status: AttendanceStatus = lateMin > 0 ? "LATE" : "ON_TIME"

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
      throw new Error("ALREADY_CLOCKED_IN")
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
    const today = startOfDay(now)

    const [existing, employee] = await Promise.all([
      prisma.attendanceRecord.findUnique({
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
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    const orgId = employee?.organizationId ?? null
    let openSession = existing?.sessions[0] ?? null

    if (!openSession) {
      // Migration gap: employee clocked in with the old code path which
      // didn't create an AttendanceSession. Create one retroactively so
      // this clock-out can proceed.
      if (existing?.timeIn) {
        const retroSession = await prisma.attendanceSession.create({
          data: {
            attendanceRecordId: existing.id,
            startedAt: existing.timeIn,
            status: (existing.status as AttendanceStatus) === "LATE" ? "LATE" : "ON_TIME",
            project: existing.project ?? null,
            projectId: existing.projectId ?? null,
            clockInLat: existing.clockInLat ?? null,
            clockInLng: existing.clockInLng ?? null,
            clockInDistanceMeters: existing.clockInDistanceMeters ?? null,
          },
          select: { id: true, startedAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
        })
        openSession = { id: retroSession.id, startedAt: retroSession.startedAt, breaks: retroSession.breaks }
      } else {
        throw new Error("NOT_CLOCKED_IN")
      }
    }

    const [hours, tz] = await Promise.all([
      this.getWorkingHours(orgId, existing?.projectId ?? null),
      this.getOrgTimezone(orgId),
    ])

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

    // Clamp effective clock-in to the project's working-hours start.
    let effectiveTimeIn: Date = openSession.startedAt
    const expectedStart = expectedTimeOnLocalDay(now, hours.start, tz)
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

    // Auto-create an OT ApprovalRequest when the day's worked minutes
    // exceed the org's daily OT threshold. Routed through the team's
    // multi-layer chain (filtered by Team.moduleConfig.OT) — the work
    // only buckets as OT once the chain reaches APPROVED.
    let otPendingApproverIds: string[] = []
    if (durationMin && orgId) {
      const [org, employeeProfile] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: orgId },
          select: { otEnabled: true },
        }),
        prisma.employeeProfile.findUnique({
          where: { userId: employeeId },
          select: {
            policy: {
              select: {
                otEnabled: true,
                otDailyThresholdMinutes: true,
              },
            },
          },
        }),
      ])
      const policyOtEnabled = employeeProfile?.policy?.otEnabled ?? true
      const threshold = employeeProfile?.policy?.otDailyThresholdMinutes ?? 480
      if (org?.otEnabled && policyOtEnabled && durationMin > threshold) {
        const otMinutes = durationMin - threshold
        const existingOt = await prisma.approvalRequest.findFirst({
          where: { employeeId, date: today, kind: "OT" },
          select: { id: true, status: true },
        })
        if (!existingOt) {
          const profile = await prisma.employeeProfile.findUnique({
            where: { userId: employeeId },
            select: {
              id: true,
              policy: { select: { otEnabled: true, otMethod: true } },
            },
          })
          const payout =
            profile?.policy?.otEnabled && profile.policy.otMethod === "TIME_BANK"
              ? "TIME_BANK"
              : "CASH"
          const otAutoApprove = await shouldAutoApprove({
            employeeId,
            role: employee?.role,
            projectId: existing?.projectId ?? null,
            kind: "OT",
          })
          const otApproval = await prisma.approvalRequest.create({
            data: {
              employeeId,
              kind: "OT",
              status: otAutoApprove ? "APPROVED" : "PENDING",
              date: today,
              eventAt: now,
              title: `OT • ${formatHm(otMinutes)}`,
              detail: `Worked ${formatHm(durationMin)} (threshold ${formatHm(threshold)}). Excess of ${formatHm(otMinutes)} requested as OT.`,
              project: existing?.project ?? null,
              otSubtype: null,
              otPayoutMethod: payout,
              ...(otAutoApprove
                ? {
                    reviewerId: employeeId,
                    reviewedAt: now,
                    reviewNotes: "Auto-approved (supervisor self-attendance)",
                  }
                : {}),
            },
          })
          if (otAutoApprove && payout === "TIME_BANK" && profile) {
            await prisma.employeeProfile.update({
              where: { id: profile.id },
              data: { otTimeBalanceMin: { increment: otMinutes } },
            })
          }
          if (!otAutoApprove) {
            otPendingApproverIds = await resolveCurrentApproverIds(
              otApproval.id,
              employeeId,
              "OT",
              existing?.projectId ?? null,
            )
          }
        }
      }
    }

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
      pendingApproverIds: Array.from(
        new Set([...clockOutApproverIds, ...otPendingApproverIds]),
      ),
    }
  },

  async startBreak(
    employeeId: string,
    location?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
  ): Promise<{ approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)
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
    const tz = await this.getOrgTimezone(employee?.organizationId ?? null)

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
    return { approvalId: approval.id }
  },

  async endBreak(
    employeeId: string,
    location?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
  ): Promise<{ approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)
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
    const tz = await this.getOrgTimezone(employee?.organizationId ?? null)

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
    return { approvalId: approval.id }
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

    // Auto-create an OT ApprovalRequest when the recomputed durationMin
    // exceeds the daily OT threshold. Mirrors the regular clock-out
    // flow's auto-OT block (see clockOut around line 1183+) so a
    // supervisor's session edit produces an OT request for the excess
    // minutes the same way an over-8h clock-out would. Conservative:
    // only CREATE when no OT request exists for this date; never
    // overwrite or delete an existing one.
    //
    // When an OT row is created and pending review, we resolve its
    // first-step approvers and bubble them up so the calling service
    // can publish a realtime refresh — without this, the next
    // supervisor's sidebar badge stayed stale until page reload.
    let pendingApproverIds: string[] = []
    const orgId = existing.employee?.organizationId ?? null
    if (durationMin && orgId) {
      const [org, employeeProfile] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: orgId },
          select: { otEnabled: true },
        }),
        prisma.employeeProfile.findUnique({
          where: { userId: existing.employeeId },
          select: {
            id: true,
            policy: {
              select: {
                otEnabled: true,
                otDailyThresholdMinutes: true,
                otMethod: true,
              },
            },
          },
        }),
      ])
      const policyOtEnabled = employeeProfile?.policy?.otEnabled ?? true
      const threshold = employeeProfile?.policy?.otDailyThresholdMinutes ?? 480
      if (org?.otEnabled && policyOtEnabled && durationMin > threshold) {
        const otMinutes = durationMin - threshold
        const existingOt = await prisma.approvalRequest.findFirst({
          where: {
            employeeId: existing.employeeId,
            date: existing.date,
            kind: "OT",
          },
          select: { id: true },
        })
        if (!existingOt) {
          const payout =
            employeeProfile?.policy?.otEnabled &&
            employeeProfile.policy.otMethod === "TIME_BANK"
              ? "TIME_BANK"
              : "CASH"
          const otAutoApprove = await shouldAutoApprove({
            employeeId: existing.employeeId,
            role: existing.employee?.role,
            projectId: existing.projectId ?? null,
            kind: "OT",
          })
          const now = new Date()
          const otApproval = await prisma.approvalRequest.create({
            data: {
              employeeId: existing.employeeId,
              kind: "OT",
              status: otAutoApprove ? "APPROVED" : "PENDING",
              date: existing.date,
              eventAt: now,
              title: `OT • ${formatHm(otMinutes)}`,
              detail: `Worked ${formatHm(durationMin)} (threshold ${formatHm(threshold)}). Excess of ${formatHm(otMinutes)} requested as OT.`,
              project: existing.project ?? null,
              otSubtype: null,
              otPayoutMethod: payout,
              ...(otAutoApprove
                ? {
                    reviewerId: existing.employeeId,
                    reviewedAt: now,
                    reviewNotes: "Auto-approved (supervisor self-attendance)",
                  }
                : {}),
            },
            select: { id: true },
          })
          if (otAutoApprove && payout === "TIME_BANK" && employeeProfile) {
            await prisma.employeeProfile.update({
              where: { id: employeeProfile.id },
              data: { otTimeBalanceMin: { increment: otMinutes } },
            })
          }
          if (!otAutoApprove) {
            pendingApproverIds = await resolveCurrentApproverIds(
              otApproval.id,
              existing.employeeId,
              "OT",
              existing.projectId ?? null,
            )
          }
        }
      }
    }

    return {
      id: existing.id,
      timeIn: nextTimeIn,
      timeOut: nextTimeOut,
      pendingApproverIds,
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
    const today = startOfDay(new Date())
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
    const today = startOfDay(new Date())

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
      include: { employee: { select: { name: true } } },
      take: 100,
    })
    const baseViews = records.map(approvalToView)
    const withContext = await attachChainContext(baseViews)
    // Only show requests where this supervisor is among the current step's
    // approvers — multi-layer chain enforcement.
    const filtered = withContext.filter((v) =>
      v.currentStepApproverIds.includes(supervisorId),
    )
    return backfillLateMinutes(filtered, prisma)
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
        employeeProfile: {
          select: {
            employeeId: true,
            jobTitle: true,
            projectAssignments: {
              select: { project: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
        approvalChainSteps: {
          where: { step: 1 },
          select: { approver: { select: { name: true } } },
          take: 1,
        },
      },
    })
    if (!user) return null
    const primaryProject = user.employeeProfile?.projectAssignments?.[0]?.project?.name ?? null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      initials: buildInitials(user.name),
      jobTitle: user.employeeProfile?.jobTitle ?? null,
      project: primaryProject,
      employeeIdRef: user.employeeProfile?.employeeId ?? null,
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
    const today = startOfDay(new Date())
    const users = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(policyIdScope && policyIdScope.length > 0
          ? { employeeProfile: { policyId: { in: policyIdScope } } }
          : {}),
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        employeeProfile: {
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

    // Month range (UTC calendar month containing today)
    const now = new Date()
    const monthFrom = startOfDay(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    )
    const monthTo = endOfDay(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
    )

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
      const primary = u.employeeProfile?.projectAssignments?.[0]?.project ?? null
      const projectName =
        u.employeeProfile?.projectAssignments
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
      const leaveDeduction = u.employeeProfile?.id
        ? await paidLeaveMinutes(u.employeeProfile.id, monthFrom, monthTo, standardDailyMin)
        : 0
      const monthExpectedMin = Math.max(0, scheduledMin - leaveDeduction)
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        initials: buildInitials(u.name),
        jobTitle: u.employeeProfile?.jobTitle ?? null,
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
    options?: { policyIdScope?: string[] | null },
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
    const prisma = getClient()
    const today = startOfDay(new Date())

    const employeeIds = await this.resolveScopedEmployeeIds(orgId, {
      projectId,
      teamId,
      q,
    })
    if (employeeIds && employeeIds.length === 0) return []

    const users = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
        ...(policyIdScope && policyIdScope.length > 0
          ? { employeeProfile: { policyId: { in: policyIdScope } } }
          : {}),
      },
      orderBy: [{ name: "asc" }],
      select: {
        id: true,
        name: true,
        employeeProfile: {
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
        timeIn: true,
        timeOut: true,
        clockInDistanceMeters: true,
        clockInLat: true,
        clockInLng: true,
        clockOutLat: true,
        clockOutLng: true,
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
      // Only employees with actual activity today (any AttendanceRecord
      // — clock event OR on-leave row). Employees who haven't touched
      // attendance today are excluded from the roster so the table
      // focuses on what HR is actually reviewing.
      .filter((u) => byUser.has(u.id))
      .map((u) => {
      const rec = byUser.get(u.id)
      const projectName =
        u.employeeProfile?.projectAssignments
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
      const offSite =
        clockInDistanceMeters != null && clockInDistanceMeters > radiusM

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

      return {
        id: u.id,
        name: u.name,
        jobTitle: u.employeeProfile?.jobTitle ?? null,
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
        attendanceRecordId: rec?.id ?? null,
        hasSelfie: !!rec?.xeroSelfieFileId,
        hasClockOutSelfie: !!rec?.clockOutXeroSelfieFileId,
        sessions,
      }
    })
  },

  async getOffSiteClockInsForToday(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
    options?: { policyIdScope?: string[] | null },
  ): Promise<
    Array<{
      id: string
      employeeId: string
      employeeName: string
      project: string | null
      timeIn: string | null
      clockInLat: number | null
      clockInLng: number | null
      clockInDistanceMeters: number
      notes: string | null
    }>
  > {
    if (!orgId) return []
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const prisma = getClient()
    const today = startOfDay(new Date())

    const employeeIds = await this.resolveScopedEmployeeIds(orgId, {
      projectId,
      teamId,
      q,
    })
    if (employeeIds && employeeIds.length === 0) return []

    const radius = (await this.getGeofenceRadiusForOrganization(orgId)) ?? 200

    const records = await prisma.attendanceRecord.findMany({
      where: {
        date: today,
        clockInDistanceMeters: { gt: radius },
        ...(projectId ? { projectId } : {}),
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        employee: {
          organizationId: orgId,
          ...(policyIdScope && policyIdScope.length > 0
            ? { employeeProfile: { policyId: { in: policyIdScope } } }
            : {}),
        },
      },
      orderBy: { clockInDistanceMeters: "desc" },
      select: {
        id: true,
        employeeId: true,
        project: true,
        timeIn: true,
        clockInLat: true,
        clockInLng: true,
        clockInDistanceMeters: true,
        notes: true,
        employee: { select: { name: true } },
      },
    })

    return records.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      employeeName: r.employee?.name ?? r.employeeId,
      project: r.project,
      timeIn: r.timeIn?.toISOString() ?? null,
      clockInLat: r.clockInLat,
      clockInLng: r.clockInLng,
      clockInDistanceMeters: r.clockInDistanceMeters ?? 0,
      notes: r.notes,
    }))
  },

  async getEmployeeMonthSummary(
    employeeId: string,
    monthStart: Date,
  ): Promise<{
    totalMin: number
    onTime: number
    late: number
    missing: number
  }> {
    const prisma = getClient()
    const monthEnd = new Date(monthStart)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1)
    const records = await prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: monthStart, lt: monthEnd } },
      select: { durationMin: true, status: true },
    })
    return {
      totalMin: records.reduce((acc, r) => acc + (r.durationMin ?? 0), 0),
      onTime: records.filter((r) => r.status === "ON_TIME").length,
      late: records.filter((r) => r.status === "LATE").length,
      missing: records.filter((r) => r.status === "MISSING").length,
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
      const profile = await prisma.employeeProfile.findUnique({
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
        const otMinutes = await computeApprovedOtMinutes(
          prisma,
          request.employeeId,
          request.date,
        )
        if (otMinutes > 0) {
          await prisma.employeeProfile.update({
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
        ? { employeeProfile: { policyId: { in: policyIdScope } } }
        : {}),
    }
    const where =
      orgId || policyIdScope
        ? { status: "PENDING" as const, employee: employeeFilter }
        : { status: "PENDING" as const }
    const records = await prisma.approvalRequest.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      include: { employee: { select: { name: true } } },
      take: 200,
    })
    const withContext = await attachChainContext(records.map(approvalToView))
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
    const today = startOfDay(new Date())

    // When a project filter is set, scope every count/list to employees who
    // are assigned to that project (via EmployeeProjectAssignment) and to
    // attendance records actually clocked into that project.
    let employeeIds: string[] | null = null
    if (projectId && orgId) {
      employeeIds = await this.getEmployeeIdsForProject(orgId, projectId)
    }

    const policyEmployeeFilter =
      policyIdScope && policyIdScope.length > 0
        ? { employeeProfile: { policyId: { in: policyIdScope } } }
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
        ? { employeeProfile: { policyId: { in: policyIdScope } } }
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
  async getTodayRollCall(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
    options?: { policyIdScope?: string[] | null },
  ): Promise<TodayRollCall> {
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      return { late: [], onLeave: [], notClockedIn: [] }
    }
    const prisma = getClient()
    const today = startOfDay(new Date())

    let employeeIds: string[] | null = null
    if (orgId) {
      employeeIds = await this.resolveScopedEmployeeIds(orgId, {
        projectId,
        teamId,
        q,
      })
      if (employeeIds && employeeIds.length === 0) {
        return { late: [], onLeave: [], notClockedIn: [] }
      }
    }

    const policyEmployeeFilter =
      policyIdScope && policyIdScope.length > 0
        ? { employeeProfile: { policyId: { in: policyIdScope } } }
        : {}

    const userWhere = orgId ? { organizationId: orgId } : {}

    const [employees, todayRecords] = await Promise.all([
      prisma.user.findMany({
        where: {
          ...userWhere,
          role: { in: ["EMPLOYEE", "SUPERVISOR"] },
          ...(employeeIds ? { id: { in: employeeIds } } : {}),
          ...policyEmployeeFilter,
        },
        select: {
          id: true,
          name: true,
          employeeProfile: {
            select: {
              employeeId: true,
              jobTitle: true,
              projectAssignments: {
                select: { project: { select: { name: true } } },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.attendanceRecord.findMany({
        where: {
          date: today,
          ...(orgId ? { employee: { organizationId: orgId } } : {}),
          ...(projectId ? { projectId } : {}),
          ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        },
        select: {
          employeeId: true,
          status: true,
          lateByMin: true,
          timeIn: true,
        },
      }),
    ])

    const recordByEmployee = new Map<string, (typeof todayRecords)[number]>()
    for (const r of todayRecords) {
      recordByEmployee.set(r.employeeId, r)
    }

    const toPerson = (
      e: (typeof employees)[number],
      record?: (typeof todayRecords)[number]
    ): RollCallPerson => ({
      id: e.id,
      name: e.name,
      employeeId: e.employeeProfile?.employeeId ?? "",
      jobTitle: e.employeeProfile?.jobTitle ?? "",
      project:
        e.employeeProfile?.projectAssignments
          ?.map((a) => a.project.name)
          .join(", ") ?? "",
      lateByMin: record?.lateByMin ?? undefined,
      timeIn: record?.timeIn?.toISOString() ?? undefined,
    })

    const late: RollCallPerson[] = []
    const onLeave: RollCallPerson[] = []
    const notClockedIn: RollCallPerson[] = []

    for (const e of employees) {
      const record = recordByEmployee.get(e.id)
      if (!record) {
        notClockedIn.push(toPerson(e))
        continue
      }
      switch (record.status) {
        case "LATE":
          late.push(toPerson(e, record))
          break
        case "ON_LEAVE":
          onLeave.push(toPerson(e))
          break
        case "MISSING":
          notClockedIn.push(toPerson(e))
          break
        // ON_TIME / CLOCKED_IN / CLOCKED_OUT → present, not surfaced here.
        default:
          break
      }
    }

    return { late, onLeave, notClockedIn }
  },

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
        employeeProfile: {
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
      const proj = u.employeeProfile?.projectAssignments?.[0]?.project ?? null
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
      select: { employeeId: true, date: true, status: true },
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

      // Attribute the day's OT-eligible time (working-day OT + rest day
      // + public holiday) to the matching status sub-bucket so the
      // hours summary can render Approved / Pending / Rejected splits.
      // Days with NO OT request fall into none of the three — that
      // residual is implicit (totalOt − approved − pending − rejected).
      const otEligibleMin =
        bucket.otMin + bucket.restDayMin + bucket.publicHolidayMin
      if (otEligibleMin > 0 && otStatus !== null) {
        if (otStatus === "APPROVED") bucket.otApprovedMin = otEligibleMin
        else if (otStatus === "PENDING") bucket.otPendingMin = otEligibleMin
        else if (otStatus === "REJECTED") bucket.otRejectedMin = otEligibleMin
      }

      const current = perEmployee.get(record.employeeId) ?? { ...EMPTY_BUCKETS }
      perEmployee.set(record.employeeId, addBuckets(current, bucket))
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
        employeeProfile: {
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

    const proj = user.employeeProfile?.projectAssignments?.[0]?.project ?? null
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
        employeeProfile: {
          projectAssignments: { some: { projectId } },
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
        employeeProfile: { projectAssignments: { some: { projectId } } },
      })
    }
    if (teamId) {
      conditions.push({
        employeeProfile: { teamMemberships: { some: { teamId } } },
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
    for (const r of rows) {
      if (r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT") {
        const key = `${r.employeeId}|${r.date.toISOString().slice(0, 10)}`
        if (!selfieRowKeys.has(key)) {
          selfieRowKeys.set(key, { employeeId: r.employeeId, date: r.date })
        }
      }
    }
    let selfieByKey = new Map<string, string>()         // dateKey → recordId (clock-in)
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
          ? selfieByKey.get(dateKey) ?? null
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
      }
    })
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
    const from = startOfDay(args.from)
    const to = endOfDay(args.to)
    const pageSize = args.pageSize

    const policyIdScope = args.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      return { rows: [], total: 0 }
    }

    const recordWhere: Record<string, unknown> = {
      date: { gte: from, lte: to },
    }

    if (args.statuses && args.statuses.length > 0) {
      recordWhere.status = { in: args.statuses }
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
        if (scopedIds.length === 0) return { rows: [], total: 0 }
        recordWhere.employeeId = { in: scopedIds }
        // Still narrow by policy via the relation filter when scoped.
        if (Object.keys(employeeFilter).length > 0) {
          recordWhere.employee = employeeFilter
        }
      } else if (Object.keys(employeeFilter).length > 0) {
        recordWhere.employee = employeeFilter
      }
    }

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
}
