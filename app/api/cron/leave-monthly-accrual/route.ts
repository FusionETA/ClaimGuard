import { NextRequest, NextResponse } from "next/server"

import { runMonthlyAccrual } from "@/modules/leave/application/services/leave-cron.service"

/**
 * POST /api/cron/leave-monthly-accrual
 *
 * Runs on the 1st of each month. Two effects:
 *   1. For PRO_RATED entitlements, accrue (entitledDays / 12) — capped
 *      at entitledDays.
 *   2. Sweep expired carry-forward: any LeaveEntitlement whose
 *      carriedExpiresAt is in the past has its unused carried days
 *      removed and is marked expired.
 *
 * Trigger: cPanel cron, monthly:
 *   curl -X POST https://<host>/api/cron/leave-monthly-accrual \
 *     -H "Authorization: Bearer $CRON_SECRET"
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

  try {
    const result = await runMonthlyAccrual()
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "accrual failed",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
