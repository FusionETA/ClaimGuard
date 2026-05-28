import "server-only"

import nodemailer, { type Transporter } from "nodemailer"

/**
 * SMTP email sender. Reads PHPMailer-style env vars (matches the partner's
 * config convention):
 *
 *   MAIL_HOST              - smtp hostname (e.g. smtp.fastmail.com)
 *   MAIL_PORT              - 465 (SSL) or 587 (STARTTLS) — typed as a string
 *   MAIL_USERNAME          - smtp login
 *   MAIL_PASSWORD          - smtp password / app-password
 *   MAIL_ENCRYPTION        - "ssl" | "tls" — controls nodemailer `secure`.
 *                            "ssl" = full TLS from the start (port 465).
 *                            "tls" = STARTTLS on a plaintext socket (port 587).
 *   MAIL_FROM_ADDRESS      - "from" address (e.g. no-reply@altomatehr.io)
 *   MAIL_FROM_NAME         - optional display name; defaults to "AltomateHR"
 *
 * When any required env var is missing (typical for local dev) we DON'T
 * crash. `sendEmail` logs the would-be-sent payload to the console and
 * returns `{ delivered: false }`. The caller decides what to do — for
 * password-reset, we still respond 200 OK to prevent email enumeration.
 */

let transporter: Transporter | null | undefined

function buildTransporter(): Transporter | null {
  const host = process.env.MAIL_HOST?.trim()
  const portRaw = process.env.MAIL_PORT?.trim()
  const user = process.env.MAIL_USERNAME?.trim()
  const pass = process.env.MAIL_PASSWORD?.trim()
  if (!host || !portRaw || !user || !pass) {
    return null
  }
  const port = Number.parseInt(portRaw, 10)
  if (!Number.isFinite(port) || port <= 0) {
    return null
  }
  // PHPMailer's `MAIL_ENCRYPTION` mirrors nodemailer's `secure` boolean:
  // "ssl" → secure socket from the start (port 465);
  // "tls" → start plaintext + upgrade via STARTTLS (port 587).
  const encryption = process.env.MAIL_ENCRYPTION?.trim().toLowerCase()
  const secure = encryption === "ssl" || port === 465
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  })
}

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter
  try {
    transporter = buildTransporter()
  } catch (err) {
    console.warn("[email] transporter init failed:", err)
    transporter = null
  }
  return transporter
}

function getFrom(): string {
  const addr = process.env.MAIL_FROM_ADDRESS?.trim()
  const name = process.env.MAIL_FROM_NAME?.trim() || "AltomateHR"
  if (!addr) return name
  return `${name} <${addr}>`
}

export type SendEmailInput = {
  to: string
  subject: string
  html: string
  /// Plaintext fallback. When omitted, we approximate by stripping HTML
  /// tags — every email client that respects best practices renders the
  /// HTML branch, but having a text branch suppresses spam scores.
  text?: string
}

/**
 * Diagnostic helper. Reads the resolved SMTP config (without password)
 * and runs nodemailer's `transporter.verify()` — handshakes with the
 * SMTP server (auth + TLS) WITHOUT actually sending an email. Used by
 * /api/admin/email-test to surface why SMTP isn't working when the
 * `[email] send failed:` log isn't accessible.
 */
export async function verifyEmailConnection(): Promise<{
  ok: boolean
  config: {
    host: string | null
    port: number | null
    secure: boolean | null
    encryption: string | null
    username: string | null
    fromAddress: string | null
    fromName: string | null
  }
  error?: string
}> {
  const host = process.env.MAIL_HOST?.trim() ?? null
  const portRaw = process.env.MAIL_PORT?.trim() ?? null
  const port = portRaw ? Number.parseInt(portRaw, 10) : null
  const username = process.env.MAIL_USERNAME?.trim() ?? null
  const fromAddress = process.env.MAIL_FROM_ADDRESS?.trim() ?? null
  const fromName = process.env.MAIL_FROM_NAME?.trim() ?? null
  const encryption = process.env.MAIL_ENCRYPTION?.trim().toLowerCase() ?? null
  const secure =
    port != null
      ? encryption === "ssl" || port === 465
      : null

  const t = getTransporter()
  if (!t) {
    return {
      ok: false,
      config: { host, port, secure, encryption, username, fromAddress, fromName },
      error:
        "Transporter not configured — one of MAIL_HOST/PORT/USERNAME/PASSWORD is missing or empty. Restart the Node process after setting them.",
    }
  }
  try {
    await t.verify()
    return {
      ok: true,
      config: { host, port, secure, encryption, username, fromAddress, fromName },
    }
  } catch (err) {
    return {
      ok: false,
      config: { host, port, secure, encryption, username, fromAddress, fromName },
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<{ delivered: boolean; messageId?: string; reason?: string }> {
  const t = getTransporter()
  if (!t) {
    // Local-dev fallback — log + skip. Keeps `npm run dev` working without
    // SMTP env vars set. Production must always have these configured.
    console.warn(
      "[email] SMTP not configured — would have sent:",
      JSON.stringify(
        { to: input.to, subject: input.subject, snippet: input.text?.slice(0, 200) ?? "" },
        null,
        2,
      ),
    )
    return { delivered: false, reason: "smtp-not-configured" }
  }
  try {
    const info = await t.sendMail({
      from: getFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? input.html.replace(/<[^>]+>/g, ""),
    })
    return { delivered: true, messageId: info.messageId }
  } catch (err) {
    console.error("[email] send failed:", err)
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : "send-failed",
    }
  }
}
