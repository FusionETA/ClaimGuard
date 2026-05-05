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
  EMPTY_BUCKETS,
  addBuckets,
  bucketRecord,
  parseWorkingDays,
  standardDailyMinutesFrom,
  type HoursBuckets,
} from "@/modules/attendance/domain/hours-summary"
import {
  DEFAULT_TIMEZONE,
  expectedTimeOnLocalDay as expectedTimeOnLocalDayInTz,
  formatLocalHm,
} from "@/modules/attendance/domain/timezone"

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
async function backfillLateMinutes(
  views: ApprovalRequestView[],
  prisma: ReturnType<typeof getClient>,
): Promise<ApprovalRequestView[]> {
  const targets = views.filter(
    (v) => v.kind === "CLOCK_IN" && v.lateMinutes == null,
  )
  if (targets.length === 0) return views
  const records = await prisma.attendanceRecord.findMany({
    where: {
      OR: targets.map((t) => ({
        employeeId: t.employeeId,
        date: new Date(`${t.date}T00:00:00.000Z`),
      })),
    },
    select: { employeeId: true, date: true, lateByMin: true },
  })
  const lookup = new Map<string, number | null>()
  for (const r of records) {
    lookup.set(`${r.employeeId}|${r.date.toISOString().slice(0, 10)}`, r.lateByMin)
  }
  return views.map((v) => {
    if (v.kind !== "CLOCK_IN" || v.lateMinutes != null) return v
    const lateByMin = lookup.get(`${v.employeeId}|${v.date}`) ?? null
    return lateByMin && lateByMin > 0 ? { ...v, lateMinutes: lateByMin } : v
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
  breakStart: Date | null
  breakEnd: Date | null
  durationMin: number | null
  lateByMin: number | null
  location: string | null
  project: string | null
  status: string
  notes: string | null
}

function attendanceToView(r: PrismaAttendance): AttendanceRecordView {
  return {
    id: r.id,
    employeeId: r.employeeId,
    date: r.date.toISOString().slice(0, 10),
    timeIn: r.timeIn?.toISOString() ?? null,
    timeOut: r.timeOut?.toISOString() ?? null,
    breakStart: r.breakStart?.toISOString() ?? null,
    breakEnd: r.breakEnd?.toISOString() ?? null,
    durationMin: r.durationMin,
    lateByMin: r.lateByMin,
    location: r.location,
    project: r.project,
    status: r.status as AttendanceStatus,
    notes: r.notes,
  }
}

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
  lateMinutes: number | null
  offsetRef: string | null
  reviewNotes: string | null
  submittedAt: Date
  reviewedAt: Date | null
  employee?: { name: string } | null
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
    lateMinutes: r.lateMinutes,
    offsetRef: r.offsetRef,
    reviewNotes: r.reviewNotes,
    submittedAt: r.submittedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
  }
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
    legacyProject: string | null
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
            project: true,
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
      legacyProject: user.employeeProfile?.project ?? null,
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
      select: { id: true, kind: true, status: true, eventAt: true, title: true },
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
      }
    })
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
      },
    })

    const autoApprove =
      employee?.role === "SUPERVISOR" || employee?.role === "ADMIN"
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
  ): Promise<{ recordId: string; approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)

    const [existing, employee] = await Promise.all([
      prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
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
    // If still on break at clock-out, close the break now so its minutes are
    // deducted from durationMin (employees on break aren't working).
    const breakEndForCalc =
      existing?.breakStart && !existing.breakEnd ? now : existing?.breakEnd ?? null
    const breakMin =
      existing?.breakStart && breakEndForCalc
        ? Math.max(0, diffMinutes(existing.breakStart, breakEndForCalc))
        : 0
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
    const autoApprove =
      employee?.role === "SUPERVISOR" || employee?.role === "ADMIN"

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
        ...(existing?.breakStart && !existing.breakEnd ? { breakEnd: now } : {}),
        ...(appendedNotes !== undefined ? { notes: appendedNotes } : {}),
      },
      create: {
        employeeId,
        date: today,
        timeOut: now,
        status: "CLOCKED_OUT",
        location: location ?? null,
        notes: notes ? `CLOCK_OUT: ${notes}` : null,
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
        select: { project: true, notes: true, timeIn: true, breakStart: true, breakEnd: true },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    if (!existing?.timeIn) {
      throw new Error("Clock in before starting a break.")
    }
    if (existing.breakStart && !existing.breakEnd) {
      throw new Error("You're already on break.")
    }
    if (existing.breakStart && existing.breakEnd) {
      throw new Error("You've already taken your break today.")
    }
    const tz = await this.getOrgTimezone(employee?.organizationId ?? null)

    const appendedNotes = notes
      ? [existing.notes, `BREAK_START: ${notes}`].filter(Boolean).join("\n")
      : undefined
    await prisma.attendanceRecord.update({
      where: { employeeId_date: { employeeId, date: today } },
      data: {
        breakStart: now,
        ...(appendedNotes !== undefined ? { notes: appendedNotes } : {}),
      },
    })

    const autoApprove =
      employee?.role === "SUPERVISOR" || employee?.role === "ADMIN"
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
        select: { project: true, notes: true, breakStart: true, breakEnd: true },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { role: true, organizationId: true },
      }),
    ])
    if (!existing?.breakStart) {
      throw new Error("Start a break before ending one.")
    }
    if (existing.breakEnd) {
      throw new Error("Your break has already ended.")
    }
    const tz = await this.getOrgTimezone(employee?.organizationId ?? null)

    const appendedNotes = notes
      ? [existing.notes, `BREAK_END: ${notes}`].filter(Boolean).join("\n")
      : undefined
    await prisma.attendanceRecord.update({
      where: { employeeId_date: { employeeId, date: today } },
      data: {
        breakEnd: now,
        ...(appendedNotes !== undefined ? { notes: appendedNotes } : {}),
      },
    })

    const breakMin = Math.max(0, diffMinutes(existing.breakStart, now))
    const autoApprove =
      employee?.role === "SUPERVISOR" || employee?.role === "ADMIN"
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

  async getTeamMemberIds(supervisorId: string): Promise<string[]> {
    const prisma = getClient()
    const profiles = await prisma.employeeProfile.findMany({
      where: { supervisorId },
      select: { userId: true },
    })
    return profiles.map((p) => p.userId)
  },

  async getTeamOverview(supervisorId: string): Promise<SupervisorTeamOverview> {
    const prisma = getClient()
    const today = startOfDay(new Date())

    const profiles = await prisma.employeeProfile.findMany({
      where: { supervisorId },
      include: { user: { select: { id: true, name: true } } },
    })
    const memberIds = profiles.map((p) => p.userId)

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
      team: profiles.map((p) => ({
        employeeId: p.userId,
        name: p.user.name,
        initials: buildInitials(p.user.name),
        today: byMember.get(p.userId) ? attendanceToView(byMember.get(p.userId)!) : null,
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
    return backfillLateMinutes(records.map(approvalToView), prisma)
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
            project: true,
            supervisor: { select: { name: true } },
          },
        },
      },
    })
    if (!user) return null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      initials: buildInitials(user.name),
      jobTitle: user.employeeProfile?.jobTitle ?? null,
      project: user.employeeProfile?.project ?? null,
      employeeIdRef: user.employeeProfile?.employeeId ?? null,
      organizationId: user.organizationId,
      supervisorName: user.employeeProfile?.supervisor?.name ?? null,
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
        employeeProfile: { select: { jobTitle: true, project: true } },
      },
    })
    if (users.length === 0) return []
    const records = await prisma.attendanceRecord.findMany({
      where: { date: today, employeeId: { in: users.map((u) => u.id) } },
      select: { employeeId: true, status: true, timeIn: true },
    })
    const byUser = new Map(records.map((r) => [r.employeeId, r]))
    return users.map((u) => {
      const today = byUser.get(u.id)
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        initials: buildInitials(u.name),
        jobTitle: u.employeeProfile?.jobTitle ?? null,
        project: u.employeeProfile?.project ?? null,
        todayStatus: (today?.status as AttendanceStatus | undefined) ?? null,
        todayTimeIn: today?.timeIn?.toISOString() ?? null,
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
  ): Promise<void> {
    const prisma = getClient()
    await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status,
        reviewerId,
        reviewedAt: new Date(),
        reviewNotes: notes ?? null,
      },
    })
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
    return backfillLateMinutes(records.map(approvalToView), prisma)
  },

  async getOrgOverview(orgId: string | null): Promise<AdminOrgOverview> {
    const prisma = getClient()
    const today = startOfDay(new Date())

    const userWhere = orgId ? { organizationId: orgId } : {}
    const headcount = await prisma.user.count({
      where: { ...userWhere, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
    })

    const todayRecords = await prisma.attendanceRecord.findMany({
      where: orgId
        ? { date: today, employee: { organizationId: orgId } }
        : { date: today },
      include: orgId ? undefined : { employee: { select: { organizationId: true } } },
    })

    const presentToday = todayRecords.filter(
      (r) => r.status === "ON_TIME" || r.status === "LATE" || r.status === "CLOCKED_IN",
    ).length
    const lateToday = todayRecords.filter((r) => r.status === "LATE").length
    const onLeaveToday = todayRecords.filter((r) => r.status === "ON_LEAVE").length

    const pendingApprovals = await prisma.approvalRequest.count({
      where: orgId
        ? { status: "PENDING", employee: { organizationId: orgId } }
        : { status: "PENDING" },
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
  ): Promise<{
    totalAttendanceRecords: number
    totalLate: number
    totalMissing: number
    totalOnLeave: number
    pendingOT: number
  }> {
    const prisma = getClient()
    const baseWhere = {
      date: { gte: startOfDay(from), lte: endOfDay(to) },
      ...(orgId ? { employee: { organizationId: orgId } } : {}),
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
  async getTodayRollCall(orgId: string | null): Promise<TodayRollCall> {
    const prisma = getClient()
    const today = startOfDay(new Date())

    const userWhere = orgId ? { organizationId: orgId } : {}

    const [employees, todayRecords] = await Promise.all([
      prisma.user.findMany({
        where: { ...userWhere, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
        select: {
          id: true,
          name: true,
          employeeProfile: {
            select: { employeeId: true, project: true, jobTitle: true },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.attendanceRecord.findMany({
        where: orgId
          ? { date: today, employee: { organizationId: orgId } }
          : { date: today },
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
      project: e.employeeProfile?.project ?? "",
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
    from: Date
    to: Date
  }): Promise<{
    totals: HoursBuckets
    employees: Array<{
      employeeId: string
      name: string
      email: string
      initials: string
      buckets: HoursBuckets
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

    const employees = await prisma.user.findMany({
      where: employeeWhere,
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, email: true },
    })
    if (employees.length === 0) {
      return { totals: { ...EMPTY_BUCKETS }, employees: [] }
    }
    const employeeIds = employees.map((e) => e.id)

    const records = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        date: { gte: from, lte: to },
        durationMin: { not: null },
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
      )
      const hasApprovedOT = otSet.has(otKey(record.employeeId, record.date))

      const bucket = bucketRecord({
        durationMin: dur,
        date: record.date,
        isPublicHoliday: isPH,
        workingDays,
        standardDailyMin,
        hasApprovedOT,
      })

      const current = perEmployee.get(record.employeeId) ?? { ...EMPTY_BUCKETS }
      perEmployee.set(record.employeeId, addBuckets(current, bucket))
    }

    let totals: HoursBuckets = { ...EMPTY_BUCKETS }
    const rows = employees.map((e) => {
      const buckets = perEmployee.get(e.id) ?? { ...EMPTY_BUCKETS }
      totals = addBuckets(totals, buckets)
      return {
        employeeId: e.id,
        name: e.name,
        email: e.email,
        initials: buildInitials(e.name),
        buckets,
      }
    })

    return { totals, employees: rows }
  },
}
