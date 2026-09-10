import "server-only"

import { sendEmail } from "@/modules/notifications/infrastructure/email"

/**
 * Welcome email for a newly-created employee: where to sign in, how
 * their password is formed, and how to keep the portal on their phone.
 *
 * Admin-triggered and opt-in — the Add-employee dialog carries a
 * "Send welcome email" checkbox, unticked by default. Nothing is sent
 * on the XLSX import or the v1 API create path, so a 200-row import
 * can't blast 200 emails by accident.
 *
 * Never throws: a create that succeeded must not be reported as failed
 * because the mail server was down. The caller surfaces the returned
 * outcome alongside its own success message.
 */

/**
 * Which password sentence the email carries. The three cases are the
 * three real outcomes of `createOrganizationMember`:
 *
 *  - `default`  — the password is the house convention (`<email><MMDD>`
 *    from `lib/auth/password.ts`), so the email can explain the format
 *    without ever printing the credential itself.
 *  - `existing` — the email matched a portal account at another company
 *    and was LINKED, not created; the typed password was ignored and
 *    they keep the one they already use.
 *  - `manual`   — anything else (an admin-typed password). We don't know
 *    it and wouldn't email it, so we say the admin will share it.
 */
export type WelcomePasswordMode = "default" | "existing" | "manual"

export type WelcomeEmailResult = {
  sent: boolean
  /// Populated when `sent` is false — safe to show an admin.
  reason?: string
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * The password paragraph, as HTML. Kept separate from the layout so the
 * three modes read as three sentences rather than three templates.
 */
function passwordBlockHtml(mode: WelcomePasswordMode, email: string): string {
  const safeEmail = escapeHtml(email)
  if (mode === "existing") {
    return `
          <p style="margin: 0; color: #3f3f46; font-size: 13px; line-height: 1.6;">
            You already have an AltomateHR account, so sign in with
            <strong>${safeEmail}</strong> and the password you use today —
            it hasn't changed.
          </p>`
  }
  if (mode === "manual") {
    return `
          <p style="margin: 0; color: #3f3f46; font-size: 13px; line-height: 1.6;">
            Your username is <strong>${safeEmail}</strong>. Your
            administrator will pass you the temporary password separately.
          </p>`
  }
  // `default` — describe the format instead of printing the credential,
  // so this email on its own isn't a working login for anyone who reads it.
  return `
          <p style="margin: 0 0 10px; color: #3f3f46; font-size: 13px; line-height: 1.6;">
            Your username is <strong>${safeEmail}</strong>.
          </p>
          <p style="margin: 0; color: #3f3f46; font-size: 13px; line-height: 1.6;">
            Your temporary password is <strong>your email address followed
            by your birthday as MMDD</strong> (2 digits for the month, then
            2 for the day). If you were born on 23 November, that's
            <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${safeEmail}1123</span>.
          </p>`
}

/**
 * The rendered email body. Exported so it can be previewed without
 * sending anything — the only way to eyeball an email that no test
 * suite covers.
 */
export function buildWelcomeEmailHtml(input: {
  name: string
  organizationName: string
  loginUrl: string
  email: string
  passwordMode: WelcomePasswordMode
}): string {
  const name = escapeHtml(input.name)
  const org = escapeHtml(input.organizationName)
  const loginUrl = escapeHtml(input.loginUrl)
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; padding: 32px 16px;">
      <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 32px;">
        <h1 style="margin: 0 0 8px; font-size: 20px; color: #18181b;">Welcome to ${org}</h1>
        <p style="margin: 0 0 20px; color: #52525b; font-size: 14px; line-height: 1.5;">
          Hi ${name}, your AltomateHR account is ready. Sign in to submit
          claims, apply for leave, clock in, and read your payslips.
        </p>
        <div style="margin: 0 0 20px;">
          <a href="${loginUrl}"
             style="display: inline-block; background: #5b21b6; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 12px 20px; border-radius: 8px;">
            Sign in to AltomateHR
          </a>
        </div>
        <p style="margin: 0 0 20px; color: #a1a1aa; font-size: 12px; line-height: 1.5; word-break: break-all;">
          Or paste this into your browser: ${loginUrl}
        </p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
${passwordBlockHtml(input.passwordMode, input.email)}
        </div>
        <div style="border-top: 1px solid #e4e4e7; padding-top: 16px; margin-bottom: 16px;">
          <p style="margin: 0 0 8px; color: #18181b; font-size: 13px; font-weight: 600;">
            Keep it on your phone
          </p>
          <p style="margin: 0; color: #52525b; font-size: 13px; line-height: 1.6;">
            There's no app store download — open the link above in your
            phone's browser, then add it to your home screen.
            On iPhone: <strong>Share &rarr; Add to Home Screen</strong>.
            On Android: <strong>menu &rarr; Install app</strong>. It then
            opens like a normal app and can send you notifications.
          </p>
        </div>
        <p style="margin: 0; color: #a1a1aa; font-size: 12px; line-height: 1.5;">
          Please change your password after your first sign-in. If you
          didn't expect this email, you can ignore it.
        </p>
      </div>
    </div>
  `
}

/**
 * Send one welcome email. Best-effort — returns the outcome instead of
 * throwing so the create action can report "added, but the email didn't
 * go out" rather than rolling anything back.
 */
export async function sendWelcomeEmail(input: {
  to: string
  name: string
  organizationName: string
  /// Public origin of this deployment, e.g. `https://hr.example.com`.
  /// Build it with `getOriginFromHeaders(await headers())` — there's no
  /// configured base URL to read from.
  origin: string
  passwordMode: WelcomePasswordMode
}): Promise<WelcomeEmailResult> {
  try {
    const loginUrl = new URL("/login", input.origin).toString()
    const result = await sendEmail({
      to: input.to,
      subject: `Welcome to ${input.organizationName} — your AltomateHR account`,
      html: buildWelcomeEmailHtml({
        name: input.name,
        organizationName: input.organizationName,
        loginUrl,
        email: input.to,
        passwordMode: input.passwordMode,
      }),
    })
    return result.delivered
      ? { sent: true }
      : { sent: false, reason: result.reason ?? "Email provider rejected it." }
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : "Unknown email error.",
    }
  }
}
