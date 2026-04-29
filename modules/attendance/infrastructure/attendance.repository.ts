import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type {
  AdminOrgOverview,
  ApprovalKind,
  ApprovalRequestView,
  ApprovalStatus,
  AttendanceRecordView,
  AttendanceStatus,
  ClockEventLite,
  OTSubtype,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"

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

function buildInitials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function diffMinutes(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / 60000)
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
}

function attendanceToView(r: PrismaAttendance): AttendanceRecordView {
  return {
    id: r.id,
    employeeId: r.employeeId,
    date: r.date.toISOString().slice(0, 10),
    timeIn: r.timeIn?.toISOString() ?? null,
    timeOut: r.timeOut?.toISOString() ?? null,
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
  // ── Working hours ──────────────────────────────────────────────────────

  async getWorkingHours(
    orgId: string | null,
  ): Promise<{ start: string; end: string }> {
    if (!orgId) return { ...SYSTEM_DEFAULT_HOURS }
    const prisma = getClient()
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { workingHoursStart: true, workingHoursEnd: true },
    })
    if (!org) return { ...SYSTEM_DEFAULT_HOURS }
    return { start: org.workingHoursStart, end: org.workingHoursEnd }
  },

  async setWorkingHours(orgId: string, start: string, end: string): Promise<void> {
    const prisma = getClient()
    await prisma.organization.update({
      where: { id: orgId },
      data: { workingHoursStart: start, workingHoursEnd: end },
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
      select: { id: true, kind: true, status: true, eventAt: true },
    })
    return events.map((e) => ({
      id: e.id,
      kind: e.kind as "CLOCK_IN" | "CLOCK_OUT" | "BREAK",
      status: e.status as ApprovalStatus,
      eventAt: (e.eventAt ?? new Date()).toISOString(),
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
    location?: string,
  ): Promise<{ recordId: string; approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)

    // Compute lateness against the employee's org working hours.
    const employee = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true },
    })
    const hours = await this.getWorkingHours(employee?.organizationId ?? null)
    const [hh, mm] = hours.start.split(":").map(Number)
    const expected = new Date(today)
    expected.setUTCHours(hh ?? 9, mm ?? 0, 0, 0)
    const lateMin = Math.max(0, diffMinutes(expected, now))
    const status: AttendanceStatus = lateMin > 0 ? "LATE" : "ON_TIME"

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: today } },
      update: { timeIn: now, lateByMin: lateMin || null, status, location: location ?? null },
      create: {
        employeeId,
        date: today,
        timeIn: now,
        lateByMin: lateMin || null,
        status,
        location: location ?? null,
      },
    })

    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "CLOCK_IN",
        status: "PENDING",
        date: today,
        eventAt: now,
        title: `Clock-in ${now.toISOString().slice(11, 16)}`,
        detail: location ? `On site at ${location}` : "Clocked in",
        location: location ?? null,
      },
    })

    return { recordId: record.id, approvalId: approval.id }
  },

  async clockOut(
    employeeId: string,
    location?: string,
  ): Promise<{ recordId: string; approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)

    const existing = await prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: today } },
    })
    const durationMin = existing?.timeIn ? diffMinutes(existing.timeIn, now) : null

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: today } },
      update: {
        timeOut: now,
        durationMin,
        status: "CLOCKED_OUT",
        location: location ?? existing?.location ?? null,
      },
      create: {
        employeeId,
        date: today,
        timeOut: now,
        status: "CLOCKED_OUT",
        location: location ?? null,
      },
    })

    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "CLOCK_OUT",
        status: "PENDING",
        date: today,
        eventAt: now,
        title: `Clock-out ${now.toISOString().slice(11, 16)}`,
        detail: durationMin
          ? `Shift duration ${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
          : "End of shift",
        location: location ?? null,
      },
    })

    return { recordId: record.id, approvalId: approval.id }
  },

  async confirmBreak(
    employeeId: string,
    location?: string,
  ): Promise<{ approvalId: string }> {
    const prisma = getClient()
    const now = new Date()
    const today = startOfDay(now)
    const approval = await prisma.approvalRequest.create({
      data: {
        employeeId,
        kind: "BREAK",
        status: "PENDING",
        date: today,
        eventAt: now,
        title: `Break check ${now.toISOString().slice(11, 16)}`,
        detail: location ? `Confirmed on site at ${location}` : "Confirmed on site",
        location: location ?? null,
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
    return records.map(approvalToView)
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
    return records.map(approvalToView)
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
}
