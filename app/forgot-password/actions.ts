"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import {
  initialRequestCodeFormState,
  initialResetPasswordFormState,
  type RequestCodeFormState,
  type ResetPasswordFormState,
} from "@/app/forgot-password/form-state"
import { hashPassword } from "@/lib/auth/password"
import {
  issuePasswordResetCode,
  verifyAndConsumePasswordResetCode,
} from "@/lib/password-reset"
import { rateLimit } from "@/lib/rate-limit"
import { normalisePhone, sendWhatsApp } from "@/lib/whatsapp"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Best-effort client IP. Same pattern as login/actions.ts.
 */
async function getClientIpForRateLimit(): Promise<string> {
  const h = await headers()
  const xff = h.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return h.get("x-real-ip") ?? h.get("cf-connecting-ip") ?? "unknown"
}

const requestSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your work email.")
    .email("Enter a valid email."),
})

/**
 * Step 1: User types their email. We:
 *
 *   - Rate-limit by IP (prevents email-blast spam).
 *   - Look up the user. ONLY proceed for EMPLOYEE / SUPERVISOR — admins
 *     handle password resets through a different channel (Altomate
 *     side), and OWNER accounts sign in via SSO with no useful password.
 *   - When the email maps to an eligible employee, generate a 6-digit
 *     code, store it in Redis with a 10-min TTL, and send it via SMTP.
 *   - In ALL cases (even unknown email / non-employee / mail failure),
 *     respond with the same generic "if the account exists you'll get
 *     a code" success status. Prevents email enumeration.
 *
 * On success we also redirect to the verify page with `?email=` so the
 * second form is pre-populated. The email is the only info on the URL
 * — the code is delivered only via the inbox.
 */
export async function requestPasswordResetAction(
  _prev: RequestCodeFormState,
  formData: FormData,
): Promise<RequestCodeFormState> {
  const rawEmail = String(formData.get("email") ?? "").trim()

  // IP rate-limit BEFORE we even validate — keeps a brute-forcer from
  // enumerating addresses by submitting garbage. 5 requests / 5 min is
  // plenty for a human, far too slow for scraping.
  const ip = await getClientIpForRateLimit()
  const rl = await rateLimit({
    scope: "password-reset-request",
    id: ip,
    max: 5,
    windowSec: 300,
  })
  if (!rl.ok) {
    return {
      status: "error",
      message: `Too many requests. Try again in ${rl.retryAfterSec}s.`,
      email: rawEmail,
    }
  }

  const parsed = requestSchema.safeParse({ email: rawEmail })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Enter a valid email.",
      email: rawEmail,
    }
  }
  const email = parsed.data.email.toLowerCase()

  // Send-or-skip is intentionally silent on the response — both branches
  // return the SAME success below to defeat enumeration. We just don't
  // actually WhatsApp anyone unless the address belongs to an employee
  // with a phone we can deliver to.
  void (async () => {
    try {
      const user = await organizationRepository.findUserWithPhoneByEmail(email)
      if (!user) return
      // Employees + supervisors only. Admins / owners use a different
      // recovery path (SSO from Altomate; partner-side reprovisioning).
      if (user.role !== "EMPLOYEE" && user.role !== "SUPERVISOR") return

      // No phone on file → no delivery path. Silently no-op so the
      // generic success response above still hides whether the
      // account exists. Admin will need to add a phone via the
      // employee detail page.
      const to = normalisePhone(user.phone)
      if (!to) {
        console.warn(
          `[password-reset] employee ${user.email} has no usable phone; skipping send`,
        )
        return
      }

      const code = await issuePasswordResetCode(email)
      if (!code) return // Redis not configured — caller already sees generic success.

      const result = await sendWhatsApp({
        to,
        text: `Hi ${user.name}, your AltomateHR password reset code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this message.`,
      })
      if (!result.delivered) {
        console.warn(
          `[password-reset] WhatsApp send to ${to} failed: ${result.reason}`,
        )
      }
    } catch (err) {
      console.error("[password-reset] background send failed:", err)
    }
  })()

  // The redirect below throws a Next.js-specific control signal; the
  // return after it never runs, but TS likes the explicit shape.
  redirect(`/forgot-password/verify?email=${encodeURIComponent(email)}`)
  return initialRequestCodeFormState
}

const resetSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1)
      .email(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Code is 6 digits."),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters.")
      .max(128, "Password is too long."),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords don't match.",
  })

/**
 * Step 2: User submits the code + new password. We verify the code
 * against Redis (single-use, 5-fail lockout), then hash + persist the
 * new password and redirect them to /login with a success indicator.
 */
export async function resetPasswordAction(
  _prev: ResetPasswordFormState,
  formData: FormData,
): Promise<ResetPasswordFormState> {
  // Same IP-level rate-limit as step 1 — blunts brute-force on the
  // verify endpoint.
  const ip = await getClientIpForRateLimit()
  const rl = await rateLimit({
    scope: "password-reset-verify",
    id: ip,
    max: 10,
    windowSec: 300,
  })
  if (!rl.ok) {
    return {
      status: "error",
      message: `Too many attempts. Try again in ${rl.retryAfterSec}s.`,
    }
  }

  const values = {
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    code: String(formData.get("code") ?? "").trim(),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  }

  const parsed = resetSchema.safeParse(values)
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      errors: {
        code: flat.code?.[0],
        newPassword: flat.newPassword?.[0],
        confirmPassword: flat.confirmPassword?.[0],
      },
      values: { code: values.code },
    }
  }

  const outcome = await verifyAndConsumePasswordResetCode(
    parsed.data.email,
    parsed.data.code,
  )
  if (!outcome.ok) {
    const message =
      outcome.reason === "no-code"
        ? "Code expired or never issued. Request a new one."
        : outcome.reason === "locked-out"
          ? "Too many wrong attempts. Request a new code."
          : "Incorrect code."
    return {
      status: "error",
      message,
      errors: { code: outcome.reason === "wrong-code" ? message : undefined },
      values: { code: values.code },
    }
  }

  // Code accepted — update the password. Look up the user one more time
  // (the code could theoretically outlive the user row if an admin
  // deletes them mid-reset; better to no-op than 500).
  const user = await organizationRepository.findUserByEmail(parsed.data.email)
  if (!user) {
    return {
      status: "error",
      message: "Account no longer exists.",
    }
  }
  // Belt-and-braces: re-check role here too in case an account is
  // demoted between request + verify. Admins shouldn't be resetting
  // via this flow.
  if (user.role !== "EMPLOYEE" && user.role !== "SUPERVISOR") {
    return {
      status: "error",
      message: "This account uses a different sign-in method.",
    }
  }

  await organizationRepository.updateUserPasswordHash(
    user.id,
    hashPassword(parsed.data.newPassword),
  )

  redirect("/login?passwordReset=1")
  return initialResetPasswordFormState
}

