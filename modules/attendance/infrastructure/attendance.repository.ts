import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { buildInitials } from "@/lib/utils"
import type {
  AdminOrgOverview,
  ApprovalKind,
  ApprovalRequestView,
  ApprovalStatus,
  AttendanceRecordView,
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
  isAutoApprovingActor,
  resolveApprovalContext,
} from "@/modules/attendance/infrastructure/approval-chain-context"
import type { ChainHistoryEntry } from "@/modules/attendance/domain/models"

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
/// Joins each CLOCK_IN view to its AttendanceRecord to fill two fields
/// in one query: lateMinutes (legacy backfill) and
/// selfieAttendanceRecordId (drives the supervisor/admin selfie
/// thumbnail). Always runs for CLOCK_IN views — bails early when the
/// view list contains none.
async function backfillLateMinutes(
  views: ApprovalRequestView[],
  prisma: ReturnType<typeof getClient>,
): Promise<ApprovalRequestView[]> {
  const targets = views.filter((v) => v.kind === "CLOCK_IN")
  if (targets.length === 0) return views
  const records = await prisma.attendanceRecord.findMany({
    where: {
      OR: targets.map((t) => ({
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
    },
  })
  type Meta = {
    recordId: string
    lateByMin: number | null
    xeroSelfieFileId: string | null
  }
  const lookup = new Map<string, Meta>()
  for (const r of records) {
    lookup.set(`${r.employeeId}|${r.date.toISOString().slice(0, 10)}`, {
      recordId: r.id,
      lateByMin: r.lateByMin,
      xeroSelfieFileId: r.xeroSelfieFileId,
    })
  }
  return views.map((v) => {
    if (v.kind !== "CLOCK_IN") return v
    const meta = lookup.get(`${v.employeeId}|${v.date}`)
    if (!meta) return v
    return {
      ...v,
      lateMinutes:
        v.lateMinutes != null
          ? v.lateMinutes
          : meta.lateByMin && meta.lateByMin > 0
            ? meta.lateByMin
            : v.lateMinutes,
      selfieAttendanceRecordId: meta.xeroSelfieFileId ? meta.recordId : null,
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
  breaks?: Array<{ startedAt: Date; endedAt: Date | null }>
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
  return {
    id: r.id,
    employeeId: r.employeeId,
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
  }
}

const BREAK_INCLUDE = {
  breaks: { select: { startedAt: true, endedAt: true } },
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
// Repository
// ---------------------------------------------------------------------------

const SYSTEM_DEFAULT_HOURS = { start: "09:00", end: "18:00" } as const

export const attendanceRepository = {
  // ── User / org lookups (used by the employee-attendance service to resolve
  // an employee's org + geofence context without bypassing the repo layer).

  async getOrganizationIdForUser(userId: string): Promise<string | null> {
    const prisma = getClient()
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    })
    return user?.organizationId ?? null
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
  ): Promise<{ recordId: string; approvalId: string }> {
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

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: today } },
      update: {
        timeIn: now,
        lateByMin: lateMin || null,
        status,
        project: projectName,
        projectId: projectId ?? null,
        location: location ?? null,
        ...(notes ? { notes: `CLOCK_IN: ${notes}` } : {}),
        ...(geo
          ? {
              clockInLat: geo.lat,
              clockInLng: geo.lng,
              clockInDistanceMeters: geo.distanceMeters,
            }
          : {}),
      },
      create: {
        employeeId,
        date: today,
        timeIn: now,
        lateByMin: lateMin || null,
        status,
        project: projectName,
        projectId: projectId ?? null,
        location: location ?? null,
        notes: notes ? `CLOCK_IN: ${notes}` : null,
        ...(geo
          ? {
              clockInLat: geo.lat,
              clockInLng: geo.lng,
              clockInDistanceMeters: geo.distanceMeters,
            }
          : {}),
      },
    })

    const autoApprove = await isAutoApprovingActor({
      employeeId,
      role: employee?.role,
      projectId: projectId ?? null,
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

    return { recordId: record.id, approvalId: approval.id }
  },

  async clockOut(
    employeeId: string,
    location?: string,
    notes?: string,
    geo?: { lat: number; lng: number; distanceMeters: number | null },
  ): Promise<{ recordId: string; approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)

    const [existing, employee] = await Promise.all([
      prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
        include: BREAK_INCLUDE,
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    const orgId = employee?.organizationId ?? null
    const [hours, tz] = await Promise.all([
      this.getWorkingHours(orgId, existing?.projectId ?? null),
      this.getOrgTimezone(orgId),
    ])

    // Close any open break sessions to `now` so their minutes deduct from
    // durationMin (employees on break aren't working).
    if (existing) {
      await prisma.breakSession.updateMany({
        where: { attendanceRecordId: existing.id, endedAt: null },
        data: { endedAt: now },
      })
    }

    // Sum total break minutes across all sessions (including ones we just
    // closed above — re-fetch to capture).
    let breakMin = 0
    if (existing) {
      const sessions = await prisma.breakSession.findMany({
        where: { attendanceRecordId: existing.id },
        select: { startedAt: true, endedAt: true },
      })
      for (const s of sessions) {
        const end = s.endedAt ?? now
        breakMin += Math.max(0, diffMinutes(s.startedAt, end))
      }
    }

    // Clamp the effective clock-in to the project's working-hours start so
    // early arrivals don't pad durationMin. (If they clocked in at 07:50 but
    // shift starts at 08:00, the 10 minutes early don't count as worked.)
    let effectiveTimeIn: Date | null = existing?.timeIn ?? null
    if (effectiveTimeIn) {
      const expectedStart = expectedTimeOnLocalDay(now, hours.start, tz)
      if (effectiveTimeIn.getTime() < expectedStart.getTime()) {
        effectiveTimeIn = expectedStart
      }
    }
    const rawDurationMin = effectiveTimeIn ? diffMinutes(effectiveTimeIn, now) : null
    const durationMin =
      rawDurationMin === null ? null : Math.max(0, rawDurationMin - breakMin)
    const autoApprove = await isAutoApprovingActor({
      employeeId,
      role: employee?.role,
      projectId: existing?.projectId ?? null,
    })

    const appendedNotes = notes
      ? [existing?.notes, `CLOCK_OUT: ${notes}`].filter(Boolean).join("\n")
      : undefined
    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: today } },
      update: {
        timeOut: now,
        durationMin,
        status: "CLOCKED_OUT",
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
      create: {
        employeeId,
        date: today,
        timeOut: now,
        status: "CLOCKED_OUT",
        location: location ?? null,
        notes: notes ? `CLOCK_OUT: ${notes}` : null,
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

    // Auto-create an OT ApprovalRequest when the day's worked minutes
    // exceed the org's daily OT threshold. Routed through the team's
    // multi-layer chain (filtered by Team.moduleConfig.OT) — the work
    // only buckets as OT once the chain reaches APPROVED.
    if (durationMin && orgId) {
      // OT threshold + per-employee enablement come from the policy
      // now. Org-level `otEnabled` is still the master kill-switch.
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
          await prisma.approvalRequest.create({
            data: {
              employeeId,
              kind: "OT",
              status: autoApprove ? "APPROVED" : "PENDING",
              date: today,
              eventAt: now,
              title: `OT • ${formatHm(otMinutes)}`,
              detail: `Worked ${formatHm(durationMin)} (threshold ${formatHm(threshold)}). Excess of ${formatHm(otMinutes)} requested as OT.`,
              project: existing?.project ?? null,
              otSubtype: null,
              otPayoutMethod: payout,
              ...(autoApprove
                ? {
                    reviewerId: employeeId,
                    reviewedAt: now,
                    reviewNotes: "Auto-approved (supervisor self-attendance)",
                  }
                : {}),
            },
          })
          if (autoApprove && payout === "TIME_BANK" && profile) {
            await prisma.employeeProfile.update({
              where: { id: profile.id },
              data: { otTimeBalanceMin: { increment: otMinutes } },
            })
          }
        }
      }
    }

    return { recordId: record.id, approvalId: approval.id }
  },

  async startBreak(
    employeeId: string,
    location?: string,
    notes?: string,
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
          timeIn: true,
          breaks: { where: { endedAt: null }, select: { id: true } },
        },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    if (!existing?.timeIn) {
      throw new Error("Clock in before starting a break.")
    }
    if (existing.breaks.length > 0) {
      throw new Error("You're already on break.")
    }
    const tz = await this.getOrgTimezone(employee?.organizationId ?? null)

    const appendedNotes = notes
      ? [existing.notes, `BREAK_START: ${notes}`].filter(Boolean).join("\n")
      : undefined
    await prisma.$transaction([
      prisma.breakSession.create({
        data: { attendanceRecordId: existing.id, startedAt: now },
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

    const autoApprove = await isAutoApprovingActor({
      employeeId,
      role: employee?.role,
      projectId: existing.projectId ?? null,
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

  async endBreak(
    employeeId: string,
    location?: string,
    notes?: string,
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
          breaks: {
            where: { endedAt: null },
            orderBy: { startedAt: "desc" },
            take: 1,
            select: { id: true, startedAt: true },
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    const openBreak = existing?.breaks[0]
    if (!existing || !openBreak) {
      throw new Error("Start a break before ending one.")
    }
    const tz = await this.getOrgTimezone(employee?.organizationId ?? null)

    const appendedNotes = notes
      ? [existing.notes, `BREAK_END: ${notes}`].filter(Boolean).join("\n")
      : undefined
    await prisma.$transaction([
      prisma.breakSession.update({
        where: { id: openBreak.id },
        data: { endedAt: now },
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
    const autoApprove = await isAutoApprovingActor({
      employeeId,
      role: employee?.role,
      projectId: existing.projectId ?? null,
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
  }): Promise<{ id: string; timeIn: Date | null; timeOut: Date | null }> {
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
        employee: { select: { organizationId: true } },
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
    return { id: existing.id, timeIn: nextTimeIn, timeOut: nextTimeOut }
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

  async getOrgEmployeeList(orgId: string | null): Promise<
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
    const prisma = getClient()
    const today = startOfDay(new Date())
    const users = await prisma.user.findMany({
      where: { organizationId: orgId, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        employeeProfile: {
          select: {
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

    return users.map((u) => {
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
      const monthExpectedMin = expectedMinutesForRange({
        from: monthFrom,
        to: monthTo,
        workingDays,
        standardDailyMin,
      })
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
    })
  },

  async getDailyActivity(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
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
      offSite: boolean
    }>
  > {
    if (!orgId) return []
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
      },
    })
    const byUser = new Map(records.map((r) => [r.employeeId, r]))

    // Active break overlay: any open BreakSession for today's records.
    const recordIds = records.map((r) => r.id)
    const activeBreakRecordIds = new Set<string>()
    if (recordIds.length > 0) {
      const breaks = await prisma.breakSession.findMany({
        where: {
          attendanceRecordId: { in: recordIds },
          endedAt: null,
        },
        select: { attendanceRecordId: true },
      })
      for (const b of breaks) activeBreakRecordIds.add(b.attendanceRecordId)
    }

    const radius = await this.getGeofenceRadiusForOrganization(orgId)
    const radiusM = radius ?? 200

    return users.map((u) => {
      const rec = byUser.get(u.id)
      const projectName =
        u.employeeProfile?.projectAssignments
          ?.map((a) => a.project.name)
          .join(", ") || null

      const status = (rec?.status as AttendanceStatus | undefined) ?? null
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
      } else if (rec && rec.timeIn && !rec.timeOut) {
        derivedStatus = rec.id && activeBreakRecordIds.has(rec.id)
          ? "ON_BREAK"
          : "WORKING"
      } else if (!rec || !rec.timeIn) {
        derivedStatus = "NOT_CLOCKED_IN"
      }

      const clockInDistanceMeters = rec?.clockInDistanceMeters ?? null
      const offSite =
        clockInDistanceMeters != null && clockInDistanceMeters > radiusM

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
        offSite,
      }
    })
  },

  async getOffSiteClockInsForToday(
    orgId: string | null,
    projectId?: string | null,
    teamId?: string | null,
    q?: string | null,
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
        employee: { organizationId: orgId },
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
    const prisma = getClient()
    const memberIds = await this.getTeamMemberIds(supervisorId)
    if (memberIds.length === 0) return 0
    return prisma.approvalRequest.count({
      where: { employeeId: { in: memberIds }, status: "PENDING" },
    })
  },

  async reviewApproval(
    approvalId: string,
    reviewerId: string,
    status: "APPROVED" | "REJECTED",
    notes?: string,
    overrideEventAt?: Date | null,
  ): Promise<void> {
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

    await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: finalStatus,
        reviewerId,
        reviewedAt: now,
        reviewNotes: notes ?? null,
        chainHistory: nextHistory as unknown as object,
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

    // Approve-with-override: when the supervisor adjusts the event time
    // while approving a CLOCK_IN/CLOCK_OUT request, patch the underlying
    // AttendanceRecord so the audit log + duration reflect the corrected
    // timestamp instead of the originally-submitted `eventAt`.
    if (
      finalStatus === "APPROVED" &&
      overrideEventAt &&
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
        await this.overrideAttendanceTimes({
          attendanceRecordId: fullRecord.id,
          editorId: reviewerId,
          editorRole: "SUPERVISOR",
          source: "APPROVE_OVERRIDE",
          ...(request.kind === "CLOCK_IN"
            ? { timeIn: overrideEventAt }
            : { timeOut: overrideEventAt }),
          reason: notes ?? null,
        })
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
  },

  // ── Admin ─────────────────────────────────────────────────────────────

  async getAllPendingApprovals(orgId?: string | null): Promise<ApprovalRequestView[]> {
    const prisma = getClient()
    const where = orgId
      ? { status: "PENDING" as const, employee: { organizationId: orgId } }
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
  ): Promise<AdminOrgOverview> {
    const prisma = getClient()
    const today = startOfDay(new Date())

    // When a project filter is set, scope every count/list to employees who
    // are assigned to that project (via EmployeeProjectAssignment) and to
    // attendance records actually clocked into that project.
    let employeeIds: string[] | null = null
    if (projectId && orgId) {
      employeeIds = await this.getEmployeeIdsForProject(orgId, projectId)
    }

    const userWhere = orgId ? { organizationId: orgId } : {}
    const headcount = await prisma.user.count({
      where: {
        ...userWhere,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
      },
    })

    const todayRecords = await prisma.attendanceRecord.findMany({
      where: {
        date: today,
        ...(orgId ? { employee: { organizationId: orgId } } : {}),
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
  ): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    const prisma = getClient()
    let employeeIds: string[] | null = null
    if (projectId && orgId) {
      employeeIds = await this.getEmployeeIdsForProject(orgId, projectId)
    }
    const baseWhere = {
      date: { gte: startOfDay(from), lte: endOfDay(to) },
      ...(orgId ? { employee: { organizationId: orgId } } : {}),
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
            ...(orgId ? { employee: { organizationId: orgId } } : {}),
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
  ): Promise<TodayRollCall> {
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

    const userWhere = orgId ? { organizationId: orgId } : {}

    const [employees, todayRecords] = await Promise.all([
      prisma.user.findMany({
        where: {
          ...userWhere,
          role: { in: ["EMPLOYEE", "SUPERVISOR"] },
          ...(employeeIds ? { id: { in: employeeIds } } : {}),
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
  }): Promise<{
    totals: HoursBuckets & { expectedMin: number }
    employees: Array<{
      employeeId: string
      name: string
      email: string
      initials: string
      buckets: HoursBuckets & { expectedMin: number }
    }>
  }> {
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
    // Per-employee OT threshold now comes from each employee's policy.
    const policyThresholds =
      employeeIds.length === 0
        ? []
        : await prisma.employeeProfile.findMany({
            where: { userId: { in: employeeIds } },
            select: {
              userId: true,
              policy: { select: { otDailyThresholdMinutes: true } },
            },
          })
    const employeeThresholdMin = new Map(
      policyThresholds
        .filter((p) => p.policy !== null)
        .map((p) => [p.userId, p.policy!.otDailyThresholdMinutes]),
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

    const approvedOT = await prisma.approvalRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        kind: "OT",
        status: "APPROVED",
        date: { gte: from, lte: to },
      },
      select: { employeeId: true, date: true },
    })
    const otKey = (employeeId: string, date: Date) =>
      `${employeeId}|${startOfDay(date).toISOString()}`
    const otSet = new Set(approvedOT.map((o) => otKey(o.employeeId, o.date)))

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
      const hasApprovedOT = otSet.has(otKey(record.employeeId, record.date))

      const bucket = bucketRecord({
        durationMin: dur,
        date: record.date,
        isPublicHoliday: isPH,
        workingDays,
        standardDailyMin,
        otThresholdMin: otThresholdFor(record.employeeId),
        hasApprovedOT,
      })

      const current = perEmployee.get(record.employeeId) ?? { ...EMPTY_BUCKETS }
      perEmployee.set(record.employeeId, addBuckets(current, bucket))
    }

    let totals: HoursBuckets = { ...EMPTY_BUCKETS }
    let totalsExpectedMin = 0
    const rows = employees.map((e) => {
      const buckets = perEmployee.get(e.id) ?? { ...EMPTY_BUCKETS }
      totals = addBuckets(totals, buckets)
      const sched = scheduleByEmployee.get(e.id)
      const expectedMin = sched
        ? expectedMinutesForRange({
            from,
            to,
            workingDays: sched.workingDays,
            standardDailyMin: sched.standardDailyMin,
          })
        : 0
      totalsExpectedMin += expectedMin
      return {
        employeeId: e.id,
        name: e.name,
        email: e.email,
        initials: buildInitials(e.name),
        buckets: { ...buckets, expectedMin },
      }
    })

    return {
      totals: { ...totals, expectedMin: totalsExpectedMin },
      employees: rows,
    }
  },

  /// Returns actual worked minutes and expected (minimum) minutes for an
  /// inclusive [from, to] date range. The schedule is resolved from the
  /// employee's first project assignment (falling back to org defaults).
  /// Public holidays / approved leave are NOT deducted from the expected
  /// total per product spec.
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

    const expectedMin = expectedMinutesForRange({
      from,
      to,
      workingDays,
      standardDailyMin,
    })

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
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
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

    const where: Record<string, unknown> = {
      status: { in: ["APPROVED", "REJECTED"] },
      reviewedAt: { gte: from, lte: to },
      reviewerId: { not: null },
    }
    if (args.orgId) {
      where.employee = { organizationId: args.orgId }
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
    if (args.orgId) {
      where.employee = { organizationId: args.orgId }
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

    // Look up selfie attachments for the CLOCK_IN rows in one query.
    const clockInRows = rows.filter((r) => r.kind === "CLOCK_IN")
    let selfieByKey = new Map<string, string>()
    if (clockInRows.length > 0) {
      const records = await prisma.attendanceRecord.findMany({
        where: {
          OR: clockInRows.map((r) => ({
            employeeId: r.employeeId,
            date: startOfDay(r.date),
          })),
        },
        select: {
          id: true,
          employeeId: true,
          date: true,
          xeroSelfieFileId: true,
        },
      })
      selfieByKey = new Map(
        records
          .filter((r) => !!r.xeroSelfieFileId)
          .map((r) => [
            `${r.employeeId}|${r.date.toISOString().slice(0, 10)}`,
            r.id,
          ]),
      )
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
        selfieAttendanceRecordId:
          r.kind === "CLOCK_IN" ? selfieByKey.get(dateKey) ?? null : null,
        overrideAt: override?.at ? override.at.toISOString() : null,
        overrideReason: override?.reason ?? null,
      }
    })
  },
}
