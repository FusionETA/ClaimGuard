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
import { sendEmail } from "@/lib/email"
import {
  issuePasswordResetCode,
  verifyAndConsumePasswordResetCode,
} from "@/lib/password-reset"
import { rateLimit } from "@/lib/rate-limit"
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
  // actually email anyone unless the address is an employee.
  void (async () => {
    try {
      const user = await organizationRepository.findUserByEmail(email)
      if (!user) return
      // Employees + supervisors only. Admins / owners use a different
      // recovery path (SSO from Altomate; partner-side reprovisioning).
      if (user.role !== "EMPLOYEE" && user.role !== "SUPERVISOR") return

      const code = await issuePasswordResetCode(email)
      if (!code) return // Redis not configured — caller already sees generic success.

      await sendEmail({
        to: email,
        subject: "Your AltomateHR password reset code",
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="margin: 0 0 12px 0; font-size: 20px;">Reset your password</h2>
            <p style="color: #555; line-height: 1.5;">
              Hi ${escapeHtml(user.name)}, use the code below to reset your AltomateHR password.
              It expires in 10 minutes.
            </p>
            <div style="margin: 24px 0; padding: 20px 24px; background: #f4f4f6; border-radius: 12px; text-align: center;">
              <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111;">${code}</div>
            </div>
            <p style="color: #888; font-size: 13px; line-height: 1.5;">
              If you didn't request this, you can safely ignore this email — your
              password won't change until someone enters this code.
            </p>
          </div>
        `,
        text: `Hi ${user.name},\n\nYour AltomateHR password reset code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`,
      })
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

/// Minimal HTML escaper for embedding user-supplied strings (the
/// employee name) into the email template. Belt + braces — names
/// shouldn't contain HTML, but we defend in depth.
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
