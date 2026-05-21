import "server-only"

import { getPrismaClient } from "@/lib/prisma"

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
  const prisma = getPrismaClient()
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
      employee: { user: { organizationId: orgId } },
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
  const prisma = getPrismaClient()
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

  const orgScope = { employee: { user: { organizationId: orgId } } }
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
