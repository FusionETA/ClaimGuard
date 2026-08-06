import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { getLeavePrismaClientSafe } from "@/modules/leave/infrastructure/leave-repository"
import { key } from "@/lib/redis"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"

export type OnLeaveTodayEntry = {
  employeeId: string
  employeeName: string
  leaveTypeCode: string
  leaveTypeName: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  startDate: string
  endDate: string
}

/// Light-weight "who is on leave today" for the admin dashboard. Returns
/// null when the org has no configured leave types (proxy for "leave
/// module not in use yet") so callers can hide the card.
export async function getOnLeaveTodayForOrg(
  orgId: string,
): Promise<OnLeaveTodayEntry[] | null> {
  const policyIdScope = await getActiveAdminPolicyScope()
  if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
  const scopeTag =
    policyIdScope === null ? "_all" : `p:${[...policyIdScope].sort().join(",")}`
  // 10-min TTL; busted by `bustLeaveCaches` on leave mutations. The
  // "today" window shifts at midnight — the short TTL bounds that
  // staleness to at most one window. Scope tag keeps two admins with
  // different policy grants from sharing entries.
  return getOrSetCache(
    key("org", orgId, "leave", "on-leave-today", scopeTag),
    600,
    () => loadOnLeaveTodayForOrg(orgId, policyIdScope),
  )
}

async function loadOnLeaveTodayForOrg(
  orgId: string,
  policyIdScope: string[] | null,
): Promise<OnLeaveTodayEntry[] | null> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return null
  const hasLeaveTypes = await prisma.leaveType.count({
    where: { organizationId: orgId, archivedAt: null },
  })
  if (hasLeaveTypes === 0) return null

  const today = new Date()
  const todayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  )
  const todayEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59),
  )

  const apps = await prisma.leaveApplication.findMany({
    where: {
      status: "APPROVED",
      startDate: { lte: todayEnd },
      endDate: { gte: todayStart },
      employee: {
        user: { organizationId: orgId },
        ...(policyIdScope && policyIdScope.length > 0
          ? { policyId: { in: policyIdScope } }
          : {}),
      },
    },
    include: {
      leaveType: { select: { code: true, name: true } },
      employee: { include: { user: { select: { name: true } } } },
    },
    orderBy: { employee: { user: { name: "asc" } } },
  })

  return apps.map((a) => ({
    employeeId: a.employeeId,
    employeeName: a.employee.user.name,
    leaveTypeCode: a.leaveType.code,
    leaveTypeName: a.leaveType.name,
    duration: a.duration as "FULL_DAY" | "MORNING" | "AFTERNOON",
    startDate: a.startDate.toISOString(),
    endDate: a.endDate.toISOString(),
  }))
}

/**
 * User IDs of employees on APPROVED leave covering today, scoped to the org
 * (+ the caller's policy grant). The attendance Today tab uses this to mark
 * on-leave employees — its "On leave" pill reads the attendance record
 * status, which is never set to ON_LEAVE from an approved leave on its own,
 * so without this the pill is always 0 and on-leave staff show as
 * "No clock-in". Mirrors the scoping of `getOnLeaveTodayForOrg`.
 */
export async function getOnLeaveUserIdsTodayForOrg(
  orgId: string,
): Promise<string[]> {
  const policyIdScope = await getActiveAdminPolicyScope()
  if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
  const scopeTag =
    policyIdScope === null ? "_all" : `p:${[...policyIdScope].sort().join(",")}`
  return getOrSetCache(
    key("org", orgId, "leave", "on-leave-today-userids", scopeTag),
    600,
    () => loadOnLeaveUserIdsTodayForOrg(orgId, policyIdScope),
  )
}

async function loadOnLeaveUserIdsTodayForOrg(
  orgId: string,
  policyIdScope: string[] | null,
): Promise<string[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []
  const today = new Date()
  const todayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  )
  const todayEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59),
  )
  const apps = await prisma.leaveApplication.findMany({
    where: {
      status: "APPROVED",
      startDate: { lte: todayEnd },
      endDate: { gte: todayStart },
      employee: {
        user: { organizationId: orgId },
        ...(policyIdScope && policyIdScope.length > 0
          ? { policyId: { in: policyIdScope } }
          : {}),
      },
    },
    select: { employee: { select: { userId: true } } },
  })
  const ids = new Set<string>()
  for (const a of apps) {
    if (a.employee?.userId) ids.add(a.employee.userId)
  }
  return [...ids]
}

/**
 * Total approved leave days for a user (by User id) overlapping [from, to].
 * Sums each application's `totalDays` (half-days already encoded as 0.5).
 * Powers the employee attendance detail's "This month · On leave" tile —
 * attendance records are never stamped ON_LEAVE, so the count has to come from
 * the leave book. Applications straddling the range boundary are counted in
 * full (rare, and good enough for a summary tile).
 */
export async function getApprovedLeaveDaysInRangeForUser(
  userId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return 0
  const apps = await prisma.leaveApplication.findMany({
    where: {
      status: "APPROVED",
      startDate: { lte: to },
      endDate: { gte: from },
      employee: { userId },
    },
    select: { totalDays: true },
  })
  return apps.reduce((acc, a) => acc + a.totalDays, 0)
}

export type LeaveAuditEntry = {
  id: string
  employeeId: string
  employeeName: string
  leaveTypeId: string
  leaveTypeCode: string
  leaveTypeName: string
  startDate: string
  endDate: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  totalDays: number
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
  createdAt: string
  decidedAt: string | null
}

export type LeaveAuditFilters = {
  /// Inclusive YYYY-MM-DD strings; when omitted the date filter is skipped.
  from?: string
  to?: string
  status?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "ALL"
  leaveTypeId?: string | "ALL"
  /// Case-insensitive substring match against employee name / email.
  q?: string
  /// Soft cap on rows returned. Default 50.
  limit?: number
}

/// Filterable audit log of leave applications for a single org. Used by
/// the admin overview page to replace the simpler "Recent applications"
/// card.
export async function listLeaveAuditLog(
  orgId: string,
  filters: LeaveAuditFilters = {},
): Promise<LeaveAuditEntry[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  const policyIdScope = await getActiveAdminPolicyScope()
  if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
  const policyFilter =
    policyIdScope && policyIdScope.length > 0
      ? { policyId: { in: policyIdScope } }
      : {}

  const where: Record<string, unknown> = {
    employee: { user: { organizationId: orgId }, ...policyFilter },
  }
  if (filters.status && filters.status !== "ALL") {
    where.status = filters.status
  }
  if (filters.leaveTypeId && filters.leaveTypeId !== "ALL") {
    where.leaveTypeId = filters.leaveTypeId
  }
  if (filters.from || filters.to) {
    // Filter applications whose [startDate, endDate] overlaps the window.
    const fromD = filters.from ? new Date(`${filters.from}T00:00:00Z`) : null
    const toD = filters.to ? new Date(`${filters.to}T23:59:59Z`) : null
    if (fromD && toD) {
      where.startDate = { lte: toD }
      where.endDate = { gte: fromD }
    } else if (fromD) {
      where.endDate = { gte: fromD }
    } else if (toD) {
      where.startDate = { lte: toD }
    }
  }
  if (filters.q && filters.q.trim()) {
    const needle = filters.q.trim()
    where.employee = {
      user: {
        organizationId: orgId,
        OR: [
          { name: { contains: needle } },
          { email: { contains: needle } },
        ],
      },
      ...policyFilter,
    }
  }

  const rows = await prisma.leaveApplication.findMany({
    where,
    include: {
      leaveType: { select: { code: true, name: true } },
      employee: { include: { user: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, filters.limit ?? 50), 200),
  })

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employee.user.name,
    leaveTypeId: r.leaveTypeId,
    leaveTypeCode: r.leaveType.code,
    leaveTypeName: r.leaveType.name,
    startDate: r.startDate.toISOString(),
    endDate: r.endDate.toISOString(),
    duration: r.duration as "FULL_DAY" | "MORNING" | "AFTERNOON",
    totalDays: r.totalDays,
    status: r.status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED",
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  }))
}

export type LeaveOverviewReport = {
  year: number
  totals: {
    pending: number
    approved: number
    rejected: number
    cancelled: number
  }
  daysUsedByType: Array<{
    leaveTypeId: string
    code: string
    name: string
    paid: boolean
    daysUsed: number
  }>
  onLeaveToday: Array<{
    employeeId: string
    employeeName: string
    leaveTypeCode: string
    leaveTypeName: string
    duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
    startDate: string
    endDate: string
  }>
  recentApplications: Array<{
    id: string
    employeeName: string
    leaveTypeCode: string
    startDate: string
    endDate: string
    duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
    totalDays: number
    status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
    createdAt: string
  }>
}

export async function getLeaveOverviewForOrg(orgId: string): Promise<LeaveOverviewReport> {
  const prisma = getLeavePrismaClientSafe()
  const year = new Date().getUTCFullYear()
  if (!prisma) {
    return {
      year,
      totals: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
      daysUsedByType: [],
      onLeaveToday: [],
      recentApplications: [],
    }
  }

  const policyIdScope = await getActiveAdminPolicyScope()
  if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
    return {
      year,
      totals: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
      daysUsedByType: [],
      onLeaveToday: [],
      recentApplications: [],
    }
  }
  const orgScope = {
    employee: {
      user: { organizationId: orgId },
      ...(policyIdScope && policyIdScope.length > 0
        ? { policyId: { in: policyIdScope } }
        : {}),
    },
  }
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59))
  const today = new Date()
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const todayEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59))

  const [
    statusGroups,
    daysByType,
    leaveTypes,
    todayApps,
    recent,
  ] = await Promise.all([
    prisma.leaveApplication.groupBy({
      by: ["status"],
      where: { ...orgScope, createdAt: { gte: yearStart, lte: yearEnd } },
      _count: { _all: true },
    }),
    prisma.leaveApplication.groupBy({
      by: ["leaveTypeId"],
      where: {
        ...orgScope,
        status: "APPROVED",
        startDate: { gte: yearStart, lte: yearEnd },
      },
      _sum: { totalDays: true },
    }),
    prisma.leaveType.findMany({
      where: { organizationId: orgId },
      select: { id: true, code: true, name: true, paid: true },
    }),
    prisma.leaveApplication.findMany({
      where: {
        ...orgScope,
        status: "APPROVED",
        startDate: { lte: todayEnd },
        endDate: { gte: todayStart },
      },
      include: {
        leaveType: { select: { code: true, name: true } },
        employee: { include: { user: { select: { name: true } } } },
      },
      orderBy: { startDate: "asc" },
    }),
    prisma.leaveApplication.findMany({
      where: orgScope,
      include: {
        leaveType: { select: { code: true } },
        employee: { include: { user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ])

  const totals = { pending: 0, approved: 0, rejected: 0, cancelled: 0 }
  for (const g of statusGroups) {
    if (g.status === "PENDING") totals.pending = g._count._all
    else if (g.status === "APPROVED") totals.approved = g._count._all
    else if (g.status === "REJECTED") totals.rejected = g._count._all
    else if (g.status === "CANCELLED") totals.cancelled = g._count._all
  }

  const daysUsedByType = leaveTypes.map((t) => {
    const sum = daysByType.find((d) => d.leaveTypeId === t.id)
    return {
      leaveTypeId: t.id,
      code: t.code,
      name: t.name,
      paid: t.paid,
      daysUsed: sum?._sum.totalDays ?? 0,
    }
  })

  return {
    year,
    totals,
    daysUsedByType,
    onLeaveToday: todayApps.map((a) => ({
      employeeId: a.employeeId,
      employeeName: a.employee.user.name,
      leaveTypeCode: a.leaveType.code,
      leaveTypeName: a.leaveType.name,
      duration: a.duration as "FULL_DAY" | "MORNING" | "AFTERNOON",
      startDate: a.startDate.toISOString(),
      endDate: a.endDate.toISOString(),
    })),
    recentApplications: recent.map((a) => ({
      id: a.id,
      employeeName: a.employee.user.name,
      leaveTypeCode: a.leaveType.code,
      startDate: a.startDate.toISOString(),
      endDate: a.endDate.toISOString(),
      duration: a.duration as "FULL_DAY" | "MORNING" | "AFTERNOON",
      totalDays: a.totalDays,
      status: a.status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED",
      createdAt: a.createdAt.toISOString(),
    })),
  }
}
