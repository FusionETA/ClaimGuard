import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { sendEmail, verifyEmailConnection } from "@/lib/email"

/**
 * GET  /api/admin/email-test
 *   → Reads the resolved MAIL_* env vars (NEVER returns the password)
 *     and runs a nodemailer `transporter.verify()` handshake against
 *     the SMTP server. No email is sent. Surfaces the exact error
 *     (auth / timeout / cert / etc.) so we can diagnose without
 *     digging through server logs.
 *
 * GET  /api/admin/email-test?to=name@example.com
 *   → Same as above, plus actually attempts to send a tiny test email
 *     to the supplied address. Useful to confirm end-to-end delivery.
 *
 * Auth: must be signed in as ADMIN or OWNER.
 *
 * Response shape (200 either way — failures are surfaced in the body
 * so the JSON can be copy-pasted back without losing structure):
 *
 *   {
 *     "verify": { "ok": true | false, "config": {...}, "error"?: "..." },
 *     "send"?:  { "ok": true | false, "messageId"?: "...", "error"?: "..." }
 *   }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized — admin / owner session required." },
      { status: 401 },
    )
  }

  const verify = await verifyEmailConnection()

  // Optional end-to-end send. Only fires when `?to=` is provided AND
  // the verify step succeeded — otherwise we'd surface the same error
  // twice without adding signal.
  const to = request.nextUrl.searchParams.get("to")?.trim() ?? null
  let send: {
    ok: boolean
    messageId?: string
    error?: string
  } | undefined

  if (to && verify.ok) {
    const result = await sendEmail({
      to,
      subject: "AltomateHR email-test diagnostic",
      html: `
        <div style="font-family: -apple-system, sans-serif; padding: 24px; max-width: 480px; margin: 0 auto;">
          <h2 style="margin: 0 0 12px 0;">SMTP is working ✓</h2>
          <p style="color: #555;">
            This is a diagnostic message sent from /api/admin/email-test.
            If you can see it, AltomateHR's password-reset emails will
            also reach this address.
          </p>
          <p style="color: #888; font-size: 13px;">
            Triggered by <strong>${escapeHtml(session.email)}</strong> at
            ${new Date().toISOString()}.
          </p>
        </div>
      `,
      text: `SMTP is working. Diagnostic email triggered by ${session.email} at ${new Date().toISOString()}.`,
    })
    send = result.delivered
      ? { ok: true, messageId: result.messageId }
      : { ok: false, error: result.reason ?? "send-failed" }
  }

  return NextResponse.json({ verify, ...(send ? { send } : {}) })
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
