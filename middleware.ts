import { type NextRequest, NextResponse } from "next/server"

const SESSION_COOKIE = "claimguard_session"

const PROTECTED_PREFIXES = ["/employee", "/admin"] as const

const ROLE_PATHS: Record<string, string> = {
  EMPLOYEE: "/employee",
  SUPERVISOR: "/employee",
  ADMIN: "/admin",
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  )

  if (!isProtected) {
    return NextResponse.next()
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value

  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url)
    return NextResponse.redirect(loginUrl)
  }

  // Decode payload (format: base64payload.base64signature)
  const [payload] = sessionCookie.split(".")
  if (!payload) {
    const loginUrl = new URL("/login", request.url)
    return NextResponse.redirect(loginUrl)
  }

  try {
    // Edge-runtime-safe base64url decode
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const session = JSON.parse(atob(base64))

    // Check expiry
    if (!session.expiresAt || session.expiresAt <= Date.now()) {
      const loginUrl = new URL("/login", request.url)
      return NextResponse.redirect(loginUrl)
    }

    // Check role matches the route they're trying to access
    const allowedBase = ROLE_PATHS[session.role]
    if (!allowedBase || !pathname.startsWith(allowedBase)) {
      const correctBase = ROLE_PATHS[session.role] ?? "/login"
      return NextResponse.redirect(new URL(correctBase, request.url))
    }

    return NextResponse.next()
  } catch {
    const loginUrl = new URL("/login", request.url)
    return NextResponse.redirect(loginUrl)
  }
}

export const config = {
  matcher: ["/employee/:path*", "/admin/:path*"],
}
