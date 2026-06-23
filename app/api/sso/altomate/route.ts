import { NextRequest, NextResponse } from "next/server"

import { buildSessionUserForEmail } from "@/lib/auth/authenticate"
import { buildSessionCookie } from "@/lib/auth/session"
import { getRedis, key } from "@/lib/redis"
import { getRequestOrigin } from "@/lib/request-origin"

/**
 * GET /api/sso/altomate?t=<ticketId>
 *
 * SSO hand-off callback. Altomate Accounting first obtains an opaque
 * ticket id via POST /api/v1/admin/sso-ticket, then redirects the
 * customer's browser here. We:
 *
 *   1. Atomically GETDEL the ticket in Redis. First click wins and
 *      consumes the ticket; an immediate duplicate click falls back to
 *      a short grace copy (see "Idempotency" below), and any later
 *      replay sees nothing and fails closed (single-use protection).
 *   2. Look up the matching admin/owner and mint our OWN iron-session
 *      cookie. Active org is set to the ticket's `organizationId` so
 *      the customer lands in the org Altomate Accounting picked.
 *   3. Redirect into /admin — middleware + everything else then works.
 *
 * The ticket TTL is 120s (minted server-side). The session it mints
 * lasts the normal 7 days.
 *
 * Idempotency / double-fire tolerance: the partner front-end can
 * navigate to this URL twice in the same tick (e.g. a React
 * StrictMode / double-`useEffect` dev build fires the redirect
 * twice). With a strict single-use GETDEL the SECOND navigation wins
 * the browser and lands on `invalid-ticket`, even though the first
 * succeeded. To avoid that we stash the consumed claims under a short
 * `sso:used:<id>` grace key (GRACE_TTL_SECONDS). A duplicate hit
 * within the window re-mints the same session and redirects to /admin
 * instead of erroring. Replay beyond the window still fails closed.
 */

type StoredTicket = {
  email: string
  organizationId: string
}

/**
 * How long a just-consumed ticket can be re-presented and still mint
 * the same session. Long enough to swallow an immediate double-nav,
 * short enough that a leaked URL can't be replayed minutes later.
 */
const GRACE_TTL_SECONDS = 30

function loginError(request: NextRequest, reason: string): NextResponse {
  // Build the redirect from the PUBLIC origin (forwarded headers) not
  // the internal listener URL — see lib/request-origin.ts.
  const url = new URL("/login", getRequestOrigin(request))
  url.searchParams.set("error", "sso")
  url.searchParams.set("reason", reason)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ticketId = request.nextUrl.searchParams.get("t")
  if (!ticketId) return loginError(request, "missing-ticket")

  const redis = getRedis()
  if (!redis) return loginError(request, "store-unavailable")

  const ticketKey = key("sso", "ticket", ticketId)
  const usedKey = key("sso", "used", ticketId)

  // Atomic GET + DEL — first click wins and consumes the ticket. A
  // duplicate (double-nav) hit then sees null on the ticket but can
  // still find the short-lived grace copy under `usedKey`. Wrapped in
  // try/catch so a transient Redis blip degrades to a clean
  // store-unavailable redirect instead of an unhandled 500.
  let raw: string | null
  try {
    raw = await redis.getdel(ticketKey)
    if (raw) {
      // Stash the consumed claims so an immediate duplicate hit is
      // idempotent. NX is intentionally omitted — last writer wins,
      // and the payload is identical either way.
      await redis.set(usedKey, raw, "EX", GRACE_TTL_SECONDS)
    } else {
      // Ticket already consumed — fall back to the grace copy.
      raw = await redis.get(usedKey)
    }
  } catch {
    return loginError(request, "store-unavailable")
  }
  if (!raw) return loginError(request, "invalid-ticket")

  let claims: StoredTicket
  try {
    claims = JSON.parse(raw) as StoredTicket
  } catch {
    return loginError(request, "invalid-ticket")
  }
  if (typeof claims.email !== "string" || claims.email.length === 0) {
    return loginError(request, "invalid-ticket")
  }

  // Identity is proven (we stored the ticket ourselves). Pass the
  // target organizationId so the session lands on the specific org
  // Altomate picked, not the user's primary org. When the claim is
  // absent on a legacy ticket, buildSessionUserForEmail falls back to
  // the user's primary org.
  const result = await buildSessionUserForEmail(claims.email, {
    targetOrganizationId: claims.organizationId,
  })
  if (!result.ok) {
    return loginError(request, result.reason)
  }

  const cookie = buildSessionCookie(result.user)
  const response = NextResponse.redirect(
    new URL("/admin", getRequestOrigin(request)),
  )
  response.cookies.set(cookie.name, cookie.value, cookie.options)
  return response
}
