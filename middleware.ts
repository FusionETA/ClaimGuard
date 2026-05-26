import { z } from "zod"
import { type NextRequest, NextResponse } from "next/server"

const SESSION_COOKIE = "claimguard_session"
const PROTECTED_PREFIXES = ["/employee", "/admin"] as const

const ROLE_PATHS: Record<string, string> = {
  EMPLOYEE: "/employee",
  SUPERVISOR: "/employee",
  ADMIN: "/admin",
  // OWNER is an admin superset — same portal as ADMIN.
  OWNER: "/admin",
}

const sessionSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["EMPLOYEE", "SUPERVISOR", "ADMIN", "OWNER"]),
  initials: z.string().min(1),
  subtitle: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  organizationName: z.string().min(1).optional(),
  activeOrganizationId: z.string().min(1).optional(),
  activeXeroConnectionId: z.string().min(1).optional(),
  expiresAt: z.number().int().positive(),
})

function getAuthSecret() {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production.")
  }

  return "claimguard-dev-auth-secret"
}

function decodeBase64Url(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, "=")
  return atob(padded)
}

function decodeBase64UrlBytes(input: string) {
  const decoded = decodeBase64Url(input)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = ""

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) {
    return false
  }

  let mismatch = 0

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index]
  }

  return mismatch === 0
}

async function signValue(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getAuthSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  )

  return encodeBase64Url(new Uint8Array(signature))
}

async function decodeSession(token: string) {
  const [payload, signature] = token.split(".")

  if (!payload || !signature) {
    return null
  }

  const expectedSignature = await signValue(payload)
  const signatureBytes = decodeBase64UrlBytes(signature)
  const expectedBytes = decodeBase64UrlBytes(expectedSignature)

  if (!timingSafeEqual(signatureBytes, expectedBytes)) {
    return null
  }

  try {
    const parsed = sessionSchema.safeParse(JSON.parse(decodeBase64Url(payload)))

    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      return null
    }

    return parsed.data
  } catch {
    return null
  }
}

function expireSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  })
}

function redirectToLogin(request: NextRequest, clearSession = false) {
  const response = NextResponse.redirect(new URL("/login", request.url))

  if (clearSession) {
    expireSessionCookie(response)
  }

  return response
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  )

  if (!isProtected) {
    return NextResponse.next()
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value

  if (!sessionCookie) {
    return redirectToLogin(request)
  }

  const session = await decodeSession(sessionCookie)

  if (!session) {
    return redirectToLogin(request, true)
  }

  // Check role matches the route they're trying to access
  const allowedBase = ROLE_PATHS[session.role]
  if (!allowedBase || !pathname.startsWith(allowedBase)) {
    const correctBase = ROLE_PATHS[session.role] ?? "/login"
    return NextResponse.redirect(new URL(correctBase, request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/employee/:path*", "/admin/:path*"],
}
