"use server"

import { requirePortalSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

function parseRange(fromIso: string, toIso: string): { from: Date; to: Date } {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid date range")
  }
  if (from > to) throw new Error("'from' date must be on or before 'to' date")
  return { from, to }
}

export async function loadOrgHoursSummaryAction(fromIso: string, toIso: string) {
  const session = await requirePortalSession("ADMIN")
  const { from, to } = parseRange(fromIso, toIso)
  return adminAttendanceService.getOrgHoursSummary(session.organizationId ?? null, from, to)
}

export async function loadEmployeeHoursSummaryAction(
  employeeId: string,
  fromIso: string,
  toIso: string,
) {
  await requirePortalSession("ADMIN")
  const { from, to } = parseRange(fromIso, toIso)
  return adminAttendanceService.getEmployeeHoursSummary(employeeId, from, to)
}
