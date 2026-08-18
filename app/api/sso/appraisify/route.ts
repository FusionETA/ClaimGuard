import { randomBytes } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession, getHomePathForRole, resolveActiveOrgId } from "@/lib/auth/session"
import { getRequestOrigin } from "@/lib/request-origin"
import { getRedis, key } from "@/lib/redis"

/**
 * GET /api/sso/appraisify
 *
 * "Launch Appraisify" — mints a short-lived SSO ticket for the CURRENTLY
 * logged-in AltomateHR user (any role) and redirects the browser to
 * AppraisifyAlt, which redeems it via POST /api/v1/auth/verify-ticket.
 *
 * Unlike /api/v1/auth/verify (ADMIN/OWNER only, credential-relay), this
 * rides on AltomateHR's OWN already-authenticated session — no password
 * re-entry, no bearer token from the browser — so it is open to every
 * role. Isolated from the existing Altomate-Accounting ticket flow
 * (POST /api/v1/admin/sso-ticket + GET /api/sso/altomate): separate Redis
 * key namespace, separate ticket shape, nothing shared but the `key()`
 * helper.
 */

type StoredAppraisifyTicket = {
  userId: string
  organizationId: string | null
}

const TICKET_TTL_SECONDS = 120

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.redirect(new URL("/login", getRequestOrigin(request)))
  }

  const appraisifyBaseUrl = process.env.APPRAISIFY_BASE_URL?.trim()
  const redis = getRedis()
  const homeUrl = new URL(getHomePathForRole(session.role), getRequestOrigin(request))

  if (!appraisifyBaseUrl || !redis) {
    homeUrl.searchParams.set("ssoError", "appraisify-unavailable")
    return NextResponse.redirect(homeUrl)
  }

  const ticketId = randomBytes(16).toString("base64url")
  const payload: StoredAppraisifyTicket = {
    userId: session.userId,
    organizationId: resolveActiveOrgId(session) ?? null,
  }

  const stored = await redis.set(
    key("sso", "appraisify", "ticket", ticketId),
    JSON.stringify(payload),
    "EX",
    TICKET_TTL_SECONDS,
    "NX",
  )
  if (stored === null) {
    homeUrl.searchParams.set("ssoError", "appraisify-unavailable")
    return NextResponse.redirect(homeUrl)
  }

  const redirectUrl = new URL("/auth/altomate-callback", appraisifyBaseUrl)
  redirectUrl.searchParams.set("t", ticketId)
  return NextResponse.redirect(redirectUrl)
}
