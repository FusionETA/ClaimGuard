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
 *   1. Atomically GETDEL the ticket in Redis. First click wins (the
 *      key is gone); any subsequent click sees an expired ticket
 *      (single-use replay protection).
 *   2. Look up the matching admin/owner and mint our OWN iron-session
 *      cookie. Active org is set to the ticket's `organizationId` so
 *      the customer lands in the org Altomate Accounting picked.
 *   3. Redirect into /admin — middleware + everything else then works.
 *
 * The ticket TTL is 120s (minted server-side). The session it mints
 * lasts the normal 7 days.
 */

type StoredTicket = {
  email: string
  organizationId: string
}

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

  // Atomic GET + DEL — first click wins. Subsequent clicks (or stale
  // bookmarks) see null and fall through to invalid-ticket.
  const raw = await redis.getdel(key("sso", "ticket", ticketId))
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
