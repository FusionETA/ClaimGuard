import { NextRequest, NextResponse } from "next/server"

import { executeDueTransfers } from "@/modules/payroll/application/services/payroll-transfer.service"

/**
 * POST /api/cron/execute-pending-transfers
 *
 * Daily sweep of `EmployeeTransfer` rows whose `effectiveDate` has
 * arrived. Each due row is executed atomically — source PayrollProfile
 * archived, target profile + payroll + membership created — and the
 * queue row moves to EXECUTED. Failures are captured on the row so the
 * next day's sweep retries automatically.
 *
 * Idempotent: rows already EXECUTED / CANCELLED are skipped.
 *
 * Recommended cron schedule: daily at 00:15 MYT (16:15 UTC prior day),
 * a few minutes AFTER `payroll-auto-archive-past-leavers` so any
 * transfers scheduled for today process the source archive cleanly.
 *
 *   curl -X POST https://<host>/api/cron/execute-pending-transfers \
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
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }

  try {
    const result = await executeDueTransfers()
    return NextResponse.json({ ok: true, ...result })
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
