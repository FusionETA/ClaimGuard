import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { createXeroOauthState, getXeroAuthorizationUrl, getXeroRuntimeConfigStatus } from "@/lib/xero"

const XERO_STATE_COOKIE = "claimguard_xero_oauth_state"

export async function GET(request: Request) {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/login", request.url))
  }

  const runtime = getXeroRuntimeConfigStatus()

  if (!runtime.configured) {
    return NextResponse.redirect(new URL("/admin/settings?xero=misconfigured", request.url))
  }

  const state = createXeroOauthState()
  const response = NextResponse.redirect(new URL(getXeroAuthorizationUrl(state)))

  response.cookies.set(XERO_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  })

  return response
}
