import { NextRequest, NextResponse } from "next/server"

import { runAutoArchivePastLeavers } from "@/modules/payroll/application/services/payroll-profile-cron.service"

/**
 * POST /api/cron/payroll-auto-archive-past-leavers
 *
 * Daily sweep of `PayrollProfile` rows where `leaveDate` has already
 * passed but `isArchived` is still false. See the service function's
 * doc block for the full rationale — the short version: it plugs the
 * "planned leaver set months in advance and nobody reopened their
 * profile after their leave date passed" gap left by the two
 * synchronous auto-archive paths (import + on-save).
 *
 * No financial impact — the payroll run already excludes past-
 * leaveDate employees from calc. This sweep is a bookkeeping fix so
 * departed staff don't clutter the Active tab of Manage Employees
 * and the "yellow banner" state clears from stale profiles.
 *
 * **Idempotent** — a re-run on the same day matches nothing.
 *
 * Trigger: cPanel cron, daily at ~00:15 MYT:
 *   curl -X POST https://<host>/api/cron/payroll-auto-archive-past-leavers \
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
    const result = await runAutoArchivePastLeavers()
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
