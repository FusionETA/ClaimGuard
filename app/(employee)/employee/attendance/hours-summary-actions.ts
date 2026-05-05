"use server"

import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

export async function loadMyHoursSummaryAction(fromIso: string, toIso: string) {
  const session = await requirePortalSession("EMPLOYEE")
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid date range")
  }
  if (from > to) throw new Error("'from' date must be on or before 'to' date")
  return employeeAttendanceService.getHoursSummary(session.userId, from, to)
}
