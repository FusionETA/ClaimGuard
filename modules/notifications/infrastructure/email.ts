import "server-only"

/**
 * Transactional email — sends via EngineMailer's REST API (was: Brevo
 * HTTP API, and nodemailer SMTP before that). Like Brevo, the HTTP API
 * bypasses DigitalOcean's default outbound-SMTP block (ports 25 / 465 /
 * 587 are blacklisted on new droplets), so it's the practical path for
 * our password-reset + payslip emails.
 *
 * EngineMailer specifics worth remembering:
 *   - Auth is a plain `APIKey` header (NOT a Bearer token).
 *   - Attachment key is `Filename` (lowercase n). `FileName` is accepted
 *     but silently treated as empty — the file arrives nameless.
 *   - Total attachment size caps at 5 MB per send.
 *   - `SenderEmail` must be a verified sender in the EngineMailer account
 *     or every send is rejected.
 *   - Failures come back INSIDE a 200 response as `Result.StatusCode`
 *     (e.g. "500"). So a real success is HTTP 2xx AND an embedded 2xx —
 *     never trust the HTTP status alone.
 *   - The body is DOUBLE-encoded: a JSON string containing JSON. One
 *     `response.json()` gives you a string, not an object. See
 *     `parseEngineMailerBody`.
 *
 * Required env vars:
 *   ENGINE_MAILER_KEY      - the API key from the EngineMailer account
 *                            (Settings → API). Sent as the `APIKey` header.
 *   EMAIL_SENDER_ADDRESS   - the verified "from" address. Falls back to
 *                            the legacy MAIL_FROM_ADDRESS if unset.
 *   EMAIL_SENDER_NAME      - display name. Falls back to MAIL_FROM_NAME,
 *                            then "AltomateHR".
 *
 * Kill switch:
 *   DISABLE_CLIENT_EMAILS  - any value other than "false" skips the send
 *                            and logs the would-be payload. Lets us pause
 *                            all outbound mail without pulling the key.
 *
 * When ENGINE_MAILER_KEY or the sender address is missing, sendEmail logs
 * the would-be-sent payload and returns { delivered: false } without
 * throwing — local dev works without provider creds; production must
 * always have these configured.
 */

const ENGINE_MAILER_ENDPOINT =
  "https://api.enginemailer.com/RESTAPI/V2/Submission/SendEmail"

/// EngineMailer's hard cap on total attachment size (base64-decoded) per
/// send. We reject before the network round-trip so the caller gets a
/// clear reason instead of a provider rejection.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

function getApiKey(): string | null {
  const k = process.env.ENGINE_MAILER_KEY?.trim()
  return k && k.length > 0 ? k : null
}

function getFromAddress(): { email: string; name: string } | null {
  const email =
    process.env.EMAIL_SENDER_ADDRESS?.trim() ||
    process.env.MAIL_FROM_ADDRESS?.trim()
  if (!email) return null
  const name =
    process.env.EMAIL_SENDER_NAME?.trim() ||
    process.env.MAIL_FROM_NAME?.trim() ||
    "AltomateHR"
  return { email, name }
}

/// Global pause: when DISABLE_CLIENT_EMAILS is set to anything other than
/// "false", we log and skip every send. Mirrors the accounting/payroll
/// apps that share the EngineMailer account.
function emailsDisabled(): boolean {
  const v = process.env.DISABLE_CLIENT_EMAILS?.trim()
  if (!v) return false
  return v.toLowerCase() !== "false"
}

export type EmailAttachment = {
  /// File name the recipient sees, e.g. "payslip-2026-07.pdf".
  filename: string
  /// Base64-encoded file content (no data: URI prefix).
  contentBase64: string
}

export type SendEmailInput = {
  to: string
  subject: string
  html: string
  /// Plaintext fallback. When omitted we approximate by stripping HTML
  /// tags — improves deliverability / spam score for clients that prefer
  /// text/plain.
  text?: string
  /// Optional file attachments (e.g. a payslip PDF). Total decoded size
  /// must stay under 5 MB.
  attachments?: EmailAttachment[]
}

/// Sum the decoded byte size of the attachments to enforce the 5 MB cap
/// before we hit the wire.
function totalAttachmentBytes(attachments: EmailAttachment[]): number {
  let total = 0
  for (const a of attachments) {
    total += Buffer.from(a.contentBase64, "base64").length
  }
  return total
}

/// EngineMailer wraps the real outcome in a `Result` object. StatusCode
/// is a string like "200" (accepted) or "500" (rejected). We treat only a
/// 2xx embedded code as delivered.
type EngineMailerResponse = {
  Result?: {
    StatusCode?: string | number
    Status?: string
    ErrorMessage?: string
    StatusReason?: string
    Detail?: string
    MessageID?: string
    TransactionID?: string
  }
}

/// EngineMailer double-encodes its response: the HTTP body is a JSON
/// *string* whose contents are themselves JSON, e.g.
///   "{\r\n  \"Result\": { \"StatusCode\": \"200\" }\r\n}"
/// A single JSON.parse yields a string, not an object — which silently
/// made every send look like "unknown-provider-error" even though the
/// mail went out. Unwrap up to two levels, tolerating either shape in
/// case they ever fix it.
function parseEngineMailerBody(raw: string): EngineMailerResponse | null {
  if (!raw) return null
  let value: unknown = raw
  for (let i = 0; i < 2; i++) {
    if (typeof value !== "string") break
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === "object"
    ? (value as EngineMailerResponse)
    : null
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<{ delivered: boolean; messageId?: string; reason?: string }> {
  if (emailsDisabled()) {
    console.warn(
      "[email] DISABLE_CLIENT_EMAILS is set — skipping send:",
      JSON.stringify({ to: input.to, subject: input.subject }, null, 2),
    )
    return { delivered: false, reason: "emails-disabled" }
  }

  const apiKey = getApiKey()
  const from = getFromAddress()
  if (!apiKey || !from) {
    console.warn(
      "[email] EngineMailer not configured — would have sent:",
      JSON.stringify(
        {
          to: input.to,
          subject: input.subject,
          snippet: input.text?.slice(0, 200) ?? "",
        },
        null,
        2,
      ),
    )
    return {
      delivered: false,
      reason: !apiKey ? "engine-mailer-key-missing" : "from-address-missing",
    }
  }

  const attachments = input.attachments ?? []
  if (attachments.length > 0) {
    const bytes = totalAttachmentBytes(attachments)
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return {
        delivered: false,
        reason: `attachments-too-large (${Math.round(bytes / 1024)}KB > 5MB cap)`,
      }
    }
  }

  try {
    const response = await fetch(ENGINE_MAILER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // NOTE: EngineMailer uses a plain APIKey header, not Bearer.
        APIKey: apiKey,
      },
      body: JSON.stringify({
        ToEmail: input.to,
        Subject: input.subject,
        SenderEmail: from.email,
        SenderName: from.name,
        SubmittedContent: input.html,
        // Lowercase-n `Filename` is mandatory — `FileName` arrives empty.
        ...(attachments.length > 0
          ? {
              Attachments: attachments.map((a) => ({
                Filename: a.filename,
                Content: a.contentBase64,
              })),
            }
          : {}),
      }),
    })

    // A transport-level non-2xx is a hard failure (rare — EngineMailer
    // mostly answers 200 and hides the outcome in the body).
    if (!response.ok) {
      const raw = await response.text().catch(() => "")
      return {
        delivered: false,
        reason: raw ? `HTTP ${response.status}: ${raw.slice(0, 200)}` : `HTTP ${response.status}`,
      }
    }

    const body = parseEngineMailerBody(await response.text().catch(() => ""))
    const code = String(body?.Result?.StatusCode ?? "")
    // The embedded status is the real verdict.
    if (!code.startsWith("2")) {
      const reason =
        body?.Result?.ErrorMessage ||
        body?.Result?.StatusReason ||
        body?.Result?.Status ||
        body?.Result?.Detail ||
        (code ? `EngineMailer status ${code}` : "unknown-provider-error")
      return { delivered: false, reason }
    }
    return {
      delivered: true,
      messageId: body?.Result?.MessageID ?? body?.Result?.TransactionID,
    }
  } catch (err) {
    console.error("[email] send failed:", err)
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : "send-failed",
    }
  }
}

/**
 * Diagnostic helper for /api/admin/email-test. EngineMailer has no cheap
 * "verify credentials" endpoint (unlike Brevo's GET /account), so this
 * only checks that the key + sender are configured and reports them
 * (without exposing the key). The real end-to-end proof is a `?to=` send,
 * which the route fires only when this returns ok.
 */
export async function verifyEmailConnection(): Promise<{
  ok: boolean
  config: {
    provider: "enginemailer"
    apiKeyConfigured: boolean
    fromAddress: string | null
    fromName: string | null
    emailsDisabled: boolean
  }
  error?: string
}> {
  const apiKey = getApiKey()
  const from = getFromAddress()
  const disabled = emailsDisabled()
  const config = {
    provider: "enginemailer" as const,
    apiKeyConfigured: apiKey != null,
    fromAddress: from?.email ?? null,
    fromName: from?.name ?? null,
    emailsDisabled: disabled,
  }
  if (!apiKey) {
    return {
      ok: false,
      config,
      error:
        "ENGINE_MAILER_KEY not set. Add it to .env (the APIKey from the EngineMailer account) and restart the Node process.",
    }
  }
  if (!from) {
    return {
      ok: false,
      config,
      error:
        "EMAIL_SENDER_ADDRESS not set. Add a verified sender address to .env and restart Node.",
    }
  }
  if (disabled) {
    return {
      ok: false,
      config,
      error:
        "DISABLE_CLIENT_EMAILS is set — all outbound mail is paused. Set it to \"false\" (or remove it) to send.",
    }
  }
  return { ok: true, config }
}
