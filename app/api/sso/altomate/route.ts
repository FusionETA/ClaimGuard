import { NextRequest, NextResponse } from "next/server"

import { buildSessionUserForEmail } from "@/lib/auth/authenticate"
import { buildSessionCookie } from "@/lib/auth/session"
import { verifySsoToken } from "@/lib/auth/sso-token"
import { getRedis, key } from "@/lib/redis"

/**
 * GET /api/sso/altomate?token=<token>
 *
 * SSO hand-off from Altomate Accounting into AltomateHR (Option C:
 * master-key + HR-signed token). Accounting first obtains the token via
 * the master-key-protected /api/v1/admin/sso-ticket endpoint, then
 * redirects the customer's browser here. We:
 *
 *   1. Verify the token — HR signed it with its own AUTH_SECRET, so HR
 *      verifies it (no shared secret). Checks signature + typ + expiry.
 *   2. Enforce single-use via the token's `jti` (Redis) to block replay
 *      if the redirect URL is captured.
 *   3. Look up the matching admin/owner and mint our OWN iron-session
 *      cookie (the same one password login issues).
 *   4. Redirect into /admin — middleware + everything else then works.
 *
 * The token is the one-time entry ticket (short expiry); the session it
 * mints lasts the normal 7 days.
 */

function loginError(request: NextRequest, reason: string): NextResponse {
  const url = new URL("/login", request.url)
  url.searchParams.set("error", "sso")
  url.searchParams.set("reason", reason)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token")
  if (!token) return loginError(request, "missing-token")

  const claims = verifySsoToken(token)
  if (!claims) return loginError(request, "invalid-token")

  // Single-use: claim the jti in Redis. If it's already claimed, this is a
  // replay — reject. When Redis isn't configured we can't enforce this, so
  // we fall back to signature + expiry only (still safe, just no replay
  // protection) rather than locking everyone out.
  const redis = getRedis()
  if (redis) {
    const nowSec = Math.floor(Date.now() / 1000)
    const ttl = Math.max(1, claims.exp - nowSec)
    const set = await redis.set(
      key("sso", "jti", claims.jti),
      "1",
      "EX",
      ttl,
      "NX",
    )
    if (set === null) return loginError(request, "replay")
  }

  // Identity is proven — mint our session for the matching admin/owner.
  const result = await buildSessionUserForEmail(claims.email)
  if (!result.ok) {
    return loginError(request, result.reason)
  }

  const cookie = buildSessionCookie(result.user)
  const response = NextResponse.redirect(new URL("/admin", request.url))
  response.cookies.set(cookie.name, cookie.value, cookie.options)
  return response
}
