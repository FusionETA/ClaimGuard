import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Route } from "next"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import type {
  AppRole,
  AuthenticatedSession,
  SessionUser,
} from "@/lib/auth/types"
import { isAdminRole, isEmployeePortalRole } from "@/lib/auth/types"

const SESSION_COOKIE_NAME = "claimguard_session"
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7

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

function getHomePath(role: AppRole) {
  return (isAdminRole(role) ? "/admin" : "/employee") as Route
}

function signValue(value: string) {
  return createHmac("sha256", getAuthSecret()).update(value).digest("base64url")
}

function encodeSession(session: AuthenticatedSession) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url")
  const signature = signValue(payload)

  return `${payload}.${signature}`
}

function decodeSession(token: string): AuthenticatedSession | null {
  const [payload, signature] = token.split(".")

  if (!payload || !signature) {
    return null
  }

  const expectedSignature = signValue(payload)
  const signatureBuffer = Buffer.from(signature, "base64url")
  const expectedBuffer = Buffer.from(expectedSignature, "base64url")

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  try {
    const parsed = sessionSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    )

    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      return null
    }

    return parsed.data
  } catch {
    return null
  }
}

function getCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  }
}

export async function createUserSession(user: SessionUser) {
  const expiresAt = Date.now() + SESSION_DURATION_MS
  const session = {
    ...user,
    expiresAt,
  }
  const cookieStore = await cookies()

  cookieStore.set(
    SESSION_COOKIE_NAME,
    encodeSession(session),
    getCookieOptions(expiresAt)
  )

  return session
}

export async function updateCurrentSession(
  patch: Partial<Omit<AuthenticatedSession, "expiresAt">>
) {
  const currentSession = await getCurrentSession()

  if (!currentSession) {
    return null
  }

  const nextSession = {
    ...currentSession,
    ...patch,
    expiresAt: currentSession.expiresAt,
  }
  const cookieStore = await cookies()

  cookieStore.set(
    SESSION_COOKIE_NAME,
    encodeSession(nextSession),
    getCookieOptions(currentSession.expiresAt)
  )

  return nextSession
}

export async function clearUserSession() {
  const cookieStore = await cookies()

  cookieStore.set(SESSION_COOKIE_NAME, "", getCookieOptions(0))
}

export async function getCurrentSession() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value

  if (!token) {
    return null
  }

  return decodeSession(token)
}

/**
 * Returns the org id the user is currently *acting on*. For admins this is
 * the company they have selected in the org dropdown (`activeOrganizationId`),
 * which can differ from their home `organizationId`. For employees and
 * supervisors the two are always equal.
 *
 * Pass `session ?? null` directly — returns undefined when the session is
 * absent or the user has no org assigned at all.
 */
export function resolveActiveOrgId(
  session: Pick<AuthenticatedSession, "activeOrganizationId" | "organizationId"> | null | undefined
): string | undefined {
  if (!session) return undefined
  return session.activeOrganizationId ?? session.organizationId
}

/**
 * Non-redirecting variant of `requirePortalSession`, intended for service-
 * layer callers that prefer to return `null` and let the caller decide
 * whether to redirect, render an empty state, or throw.
 *
 * The result is a discriminated union so TypeScript narrows `session` to
 * `AuthenticatedSession` inside the `ok` branch.
 */
export async function requireSessionForRole(
  role: AppRole
): Promise<
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; reason: "no-session" | "wrong-role" }
> {
  const session = await getCurrentSession()
  if (!session) return { ok: false, reason: "no-session" }

  const matchesEmployeePortal =
    role === "EMPLOYEE" && isEmployeePortalRole(session.role)
  // OWNER satisfies any ADMIN requirement (it's a superset of admin).
  const matchesAdminPortal = role === "ADMIN" && isAdminRole(session.role)
  if (session.role !== role && !matchesEmployeePortal && !matchesAdminPortal) {
    return { ok: false, reason: "wrong-role" }
  }
  return { ok: true, session }
}

export async function requirePortalSession(role: AppRole) {
  const session = await getCurrentSession()

  if (!session) {
    redirect("/login")
  }

  const matchesEmployeePortal =
    role === "EMPLOYEE" && isEmployeePortalRole(session.role)
  // OWNER satisfies any ADMIN requirement (it's a superset of admin).
  const matchesAdminPortal = role === "ADMIN" && isAdminRole(session.role)
  const matchesExactRole = session.role === role

  if (!matchesEmployeePortal && !matchesAdminPortal && !matchesExactRole) {
    redirect(getHomePath(session.role))
  }

  // Rolling session — extend expiry by the full duration on every authenticated visit
  // so active users are never logged out unexpectedly.
  const renewThreshold = SESSION_DURATION_MS / 2
  if (session.expiresAt - Date.now() < renewThreshold) {
    const cookieStore = await cookies()
    const newExpiresAt = Date.now() + SESSION_DURATION_MS
    const renewed = { ...session, expiresAt: newExpiresAt }
    cookieStore.set(SESSION_COOKIE_NAME, encodeSession(renewed), getCookieOptions(newExpiresAt))
  }

  return session
}

export function getHomePathForRole(role: AppRole) {
  return getHomePath(role)
}
