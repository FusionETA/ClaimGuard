import { NextResponse } from "next/server"

/**
 * GET /api/health
 *
 * Unauthenticated liveness probe. Always returns 200 when the app
 * process is up — it does NOT touch the database (a DB hiccup should not
 * make the app look "down" to the smoke workflow's pre-flight check; the
 * smoke suite itself exercises the DB-backed `/api/v1/*` routes).
 *
 * Fields:
 *   - status: always "ok" when reachable.
 *   - sha:    the deployed commit. The droplet deploy script injects
 *             `GIT_SHA=$(git rev-parse HEAD)` before the pm2 restart, so
 *             the smoke workflow can confirm it is hitting the deploy
 *             built from the commit it just pushed (and not racing an
 *             older still-warm process). Falls back to "unknown" locally.
 *   - uptime: process uptime in whole seconds.
 *
 * Closes task #52 — "Layer 3: /api/health endpoint".
 */
export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      sha: process.env.GIT_SHA ?? "unknown",
      uptime: Math.floor(process.uptime()),
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}
