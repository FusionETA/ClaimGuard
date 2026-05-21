"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import {
  initialLoginFormState,
  type LoginFormState,
} from "@/app/login/form-state"
import { authenticateUser } from "@/lib/auth/authenticate"
import {
  clearUserSession,
  createUserSession,
  getCurrentSession,
  getHomePathForRole,
} from "@/lib/auth/session"
import { rateLimit } from "@/lib/rate-limit"
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
