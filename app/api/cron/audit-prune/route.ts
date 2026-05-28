import { NextRequest, NextResponse } from "next/server"

import { pruneAuditLog } from "@/modules/audit/application/services/audit-log.service"

/**
 * POST /api/cron/audit-prune
 *
 * Daily housekeeping. Deletes `OrganizationAuditLog` rows older than
 * 7 days so the activity feed stays bounded. Safe to run multiple
 * times a day — idempotent.
 *
 * Trigger: cPanel cron, once a day (suggested 02:00 GMT+8 — low
 * traffic):
 *   curl -fsS -X POST \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     https://altomatehr-dev.fusioneta.com.my/api/cron/audit-prune \
 *     >/dev/null 2>&1
 *
 * Same Bearer-token gate as the other crons (CRON_SECRET env var).
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
    const result = await pruneAuditLog()
    return NextResponse.json(
      {
        ok: true,
        deleted: result.deleted,
        cutoff: result.cutoffIso,
      },
      { status: 200 },
    )
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "prune failed",
      },
      { status: 500 },
    )
  }
}
