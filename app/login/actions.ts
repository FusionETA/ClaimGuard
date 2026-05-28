"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import {
  initialLoginFormState,
  type LoginFormState,
} from "@/app/login/form-state"
import { authenticateUser } from "@/lib/auth/authenticate"
import { hashPassword, verifyPassword } from "@/lib/auth/password"
import {
  clearUserSession,
  createUserSession,
  getCurrentSession,
  getHomePathForRole,
} from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { pushSubscriptionRepository } from "@/modules/notifications/infrastructure/push-subscription.repository"

/**
 * Best-effort client IP for rate-limiting. Reads the standard reverse-proxy
 * headers cPanel / Vercel / Cloudflare set; falls back to a literal sentinel
 * so the limiter still buckets requests instead of failing open per call.
 */
async function getClientIpForRateLimit(): Promise<string> {
  const h = await headers()
  const xff = h.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return h.get("x-real-ip") ?? h.get("cf-connecting-ip") ?? "unknown"
}

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
})

export async function loginAction(
  _previousState: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const values = {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  }

  // Throttle credential checks per source IP. 5 attempts/minute is generous
  // for a human, prohibitively slow for credential stuffing. Fires BEFORE
  // schema validation so a brute-forcer can't trivially burn through
  // malformed-email submissions to discover valid accounts.
  const ip = await getClientIpForRateLimit()
  const rl = await rateLimit({
    scope: "login",
    id: ip,
    max: 5,
    windowSec: 60,
  })
  if (!rl.ok) {
    return {
      status: "error",
      message: `Too many login attempts. Try again in ${rl.retryAfterSec}s.`,
      values: { email: values.email },
      errors: {},
    }
  }

  const parsed = loginSchema.safeParse(values)

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    return {
      status: "error",
      message: "Please check the highlighted fields and try again.",
      values: { email: values.email },
      errors: {
        email: fieldErrors.email?.[0],
        password: fieldErrors.password?.[0],
      },
    }
  }

  // 1. Check credentials against the database.
  const result = await authenticateUser(parsed.data)

  if (!result.success) {
    return {
      status: "error",
      message: result.message,
      values: { email: parsed.data.email },
      errors: {},
    }
  }

  // 2. Create the session cookie.
  await createUserSession(result.user)

  // 3. Redirect to the correct portal.
  // NOTE: We intentionally do NOT prefetch data here. The prefetch was
  // blocking DB connections during login (causing pool exhaustion / 504s
  // under concurrent logins), and the in-memory store is per-Vercel-instance
  // so it was unreliable in multi-instance deployments anyway.
  // Pages lazy-load their own data from the DB on first visit.
  redirect(getHomePathForRole(result.user.role))
}

/**
 * Form-state shape for changePasswordAction. Matches the FormState
 * pattern used elsewhere — status + message + per-field errors.
 */
export type ChangePasswordFormState = {
  status: "idle" | "success" | "error"
  message?: string
  errors?: {
    currentPassword?: string
    newPassword?: string
    confirmPassword?: string
  }
}

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters.")
      .max(128, "Password is too long."),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords don't match.",
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    path: ["newPassword"],
    message: "New password must be different from current password.",
  })

/**
 * Authenticated change-password action. Validates the CURRENT password,
 * then writes the new hash. Session stays valid afterwards — we don't
 * force a re-login because the session is the user's own and they just
 * proved they own it by typing the current password.
 *
 * Refused for SSO-originated sessions (their `User.passwordHash` is a
 * random unusable value set at provisioning time — they sign in via
 * Altomate Accounting and never use a password here).
 */
export async function changePasswordAction(
  _prev: ChangePasswordFormState,
  formData: FormData,
): Promise<ChangePasswordFormState> {
  const session = await getCurrentSession()
  if (!session) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  if (session.loggedInViaSso) {
    return {
      status: "error",
      message:
        "This account signs in via Altomate Accounting and has no local password to change.",
    }
  }

  // IP rate-limit — same scope as login since the attack surface is
  // similar (someone trying to guess the current password).
  const ip = await getClientIpForRateLimit()
  const rl = await rateLimit({
    scope: "change-password",
    id: ip,
    max: 5,
    windowSec: 300,
  })
  if (!rl.ok) {
    return {
      status: "error",
      message: `Too many attempts. Try again in ${rl.retryAfterSec}s.`,
    }
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  })
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      errors: {
        currentPassword: flat.currentPassword?.[0],
        newPassword: flat.newPassword?.[0],
        confirmPassword: flat.confirmPassword?.[0],
      },
    }
  }

  const prisma = getPrismaClient()
  if (!prisma) {
    return { status: "error", message: "Database is not available." }
  }
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { passwordHash: true },
  })
  if (!user) {
    return { status: "error", message: "Account not found." }
  }
  if (!verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
    return {
      status: "error",
      errors: { currentPassword: "Current password is incorrect." },
      message: "Current password is incorrect.",
    }
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { passwordHash: hashPassword(parsed.data.newPassword) },
  })

  // Audit so an admin can spot a compromised account changing its
  // password (in addition to the user's own peace of mind).
  if (session.activeOrganizationId ?? session.organizationId) {
    void writeAudit({
      organizationId:
        session.activeOrganizationId ?? session.organizationId!,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "auth.password.change",
      status: "SUCCESS",
      summary: "Changed account password",
      targetType: "user",
      targetId: session.userId,
    })
  }

  return { status: "success", message: "Password updated." }
}

export const initialChangePasswordFormState: ChangePasswordFormState = {
  status: "idle",
}

export async function logoutAction() {
  // Read the session BEFORE clearing it so we know whose push
  // subscriptions to drop. Without this step the DB row stays linked
  // to the previous user, and the server keeps pushing notifications
  // to the device long after the user has logged out (was: a real bug
  // reported on the PWA — log out, still get notifications for the old
  // account).
  //
  // This is the server-side belt-and-braces. The client-side
  // (LogoutButton) also calls pushManager.unsubscribe() to release the
  // OS-level subscription; this fallback ensures the DB is always
  // clean even if that client-side step never runs.
  const session = await getCurrentSession()
  if (session?.email) {
    await pushSubscriptionRepository.deleteAllForUserEmail(session.email)
  }

  await clearUserSession()
  redirect("/login")
}
