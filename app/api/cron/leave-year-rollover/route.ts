import { NextRequest, NextResponse } from "next/server"

import { runYearRollover } from "@/modules/leave/application/services/leave-cron.service"

/**
 * POST /api/cron/leave-year-rollover
 *
 * Annual roll-forward. For every active employee × non-archived leave type,
 * creates the LeaveEntitlement row for the target year using:
 *   - entitledDays from the resolved default chain (employee override →
 *     policy default → leave-type default)
 *   - carriedDays = remaining balance of the previous year, capped by
 *     LeaveType.maxCarryForwardDays (when carryForward = true).
 *
 * Trigger: cPanel cron, once a year (Jan 1 local time):
 *   curl -X POST https://<host>/api/cron/leave-year-rollover \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Optional query param `year` overrides the target year (defaults to the
 * current UTC year). Re-runs are idempotent — existing rows for the target
 * year are skipped.
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

  const url = new URL(request.url)
  const yearParam = url.searchParams.get("year")
  // Default target year reads the calendar year in Asia/Kuala_Lumpur (the
  // org default timezone), not UTC. This makes "fire at MYT midnight Jan 1"
  // resolve to the new year even though UTC is still Dec 31 at that moment.
  const targetYear = yearParam
    ? Number(yearParam)
    : Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Kuala_Lumpur",
          year: "numeric",
        }).format(new Date()),
      )
  if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
    return NextResponse.json({ ok: false, error: "invalid year" }, { status: 400 })
  }

  try {
    const result = await runYearRollover(targetYear)
    return NextResponse.json({ ...result, year: targetYear })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "rollover failed",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
