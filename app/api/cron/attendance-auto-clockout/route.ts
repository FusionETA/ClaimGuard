import { NextRequest, NextResponse } from "next/server"

import { runAutoClockOutSweep } from "@/modules/attendance/application/services/attendance-cron.service"

/**
 * POST /api/cron/attendance-auto-clockout
 *
 * Sweep every open AttendanceSession and close ones that have exceeded
 * their employee's `EmployeePolicy.autoClockOutAfterMin`. See the
 * service function doc block for the full rationale; the short
 * version: it catches "employee forgot to click Clock Out and went
 * home", so their next-day attendance record isn't blocked and their
 * hours summary isn't polluted by a 15-hour open session.
 *
 * **Idempotent.** A session closed by a prior run no longer matches
 * `endedAt IS NULL`, so re-running the sweep mid-cycle is safe.
 *
 * **Rate-limited.** Caps at 200 candidates per fire. Backlog beyond
 * that rolls over to the next cycle.
 *
 * Trigger: cPanel cron, every 15 minutes:
 *   curl -X POST https://<host>/api/cron/attendance-auto-clockout \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Cadence choice matches the schema comment on
 * `EmployeePolicy.autoClockOutEnabled` at prisma/schema.prisma:213-215
 * ("A cron fires every 15 min and checks open sessions").
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
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }

  try {
    const result = await runAutoClockOutSweep()
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "sweep failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
