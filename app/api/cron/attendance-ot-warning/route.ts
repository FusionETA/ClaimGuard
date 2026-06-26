import { NextRequest, NextResponse } from "next/server"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

/**
 * POST /api/cron/attendance-ot-warning
 *
 * Runs nightly at 22:00 (org's local time, scheduled via vercel.json).
 * Finds every employee still clocked in and sends them a push + in-app
 * notification reminding them to add a shift remark and clock out.
 *
 * Auth: header `Authorization: Bearer <CRON_SECRET>`.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured on server" },
      { status: 500 },
    )
  }
  const auth = request.headers.get("authorization") ?? ""
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match || match[1].trim() !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const orgIds = await attendanceRepository.getAllOrganizationIds()

  let totalNotified = 0
  const results: Array<{ orgId: string; notified: number }> = []

  for (const orgId of orgIds) {
    try {
      const notified = await employeeAttendanceService.sendOtWarningNotifications({ orgId })
      totalNotified += notified
      results.push({ orgId, notified })
    } catch {
      results.push({ orgId, notified: 0 })
    }
  }

  return NextResponse.json({
    ok: true,
    totalNotified,
    orgs: results,
  })
}
