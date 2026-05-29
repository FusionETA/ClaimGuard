import "server-only"

/**
 * Transactional email — sends via Brevo's HTTP API (was: nodemailer
 * SMTP). The HTTP API bypasses DigitalOcean's default outbound-SMTP
 * block (ports 25 / 465 / 587 are blacklisted on new droplets to
 * prevent spam abuse), so this is the only practical path for our
 * password-reset emails until the support unblock comes through —
 * which can take days and isn't guaranteed.
 *
 * Required env vars:
 *   BREVO_API_KEY        - the xkeysib-... key minted in the Brevo
 *                          dashboard under SMTP & API → API Keys.
 *   MAIL_FROM_ADDRESS    - the "from" address. Reuses the same env
 *                          var name from the old SMTP setup so we
 *                          didn't churn it. For decent deliverability
 *                          the address must be on a domain verified
 *                          inside Brevo (Senders & IPs → Domains).
 *   MAIL_FROM_NAME       - optional display name. Defaults to
 *                          "AltomateHR" when unset.
 *
 * When BREVO_API_KEY or MAIL_FROM_ADDRESS are missing, sendEmail
 * logs the would-be-sent payload and returns { delivered: false }
 * without throwing. Lets local dev work without provider creds —
 * production must always have these configured.
 */

const BREVO_API_BASE = "https://api.brevo.com/v3"

function getApiKey(): string | null {
  const k = process.env.BREVO_API_KEY?.trim()
  return k && k.length > 0 ? k : null
}

function getFromAddress(): { email: string; name: string } | null {
  const email = process.env.MAIL_FROM_ADDRESS?.trim()
  if (!email) return null
  const name = process.env.MAIL_FROM_NAME?.trim() || "AltomateHR"
  return { email, name }
}

export type SendEmailInput = {
  to: string
  subject: string
  html: string
  /// Plaintext fallback. When omitted we approximate by stripping
  /// HTML tags — Brevo will use this in mail-clients that prefer
  /// text/plain, and having it suppresses spam scores.
  text?: string
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<{ delivered: boolean; messageId?: string; reason?: string }> {
  const apiKey = getApiKey()
  const from = getFromAddress()
  if (!apiKey || !from) {
    console.warn(
      "[email] Brevo not configured — would have sent:",
      JSON.stringify(
        { to: input.to, subject: input.subject, snippet: input.text?.slice(0, 200) ?? "" },
        null,
        2,
      ),
    )
    return {
      delivered: false,
      reason: !apiKey ? "brevo-key-missing" : "from-address-missing",
    }
  }
  try {
    const response = await fetch(`${BREVO_API_BASE}/smtp/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: from,
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text ?? input.html.replace(/<[^>]+>/g, ""),
      }),
    })
    if (!response.ok) {
      // Brevo returns { code, message } on errors — surface the
      // message string so the email-test endpoint shows the real
      // reason ("invalid api key", "sender not verified", etc).
      const body = (await response.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null
      return {
        delivered: false,
        reason: body?.message ?? `HTTP ${response.status}`,
      }
    }
    const body = (await response.json().catch(() => null)) as
      | { messageId?: string }
      | null
    return { delivered: true, messageId: body?.messageId }
  } catch (err) {
    console.error("[email] send failed:", err)
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : "send-failed",
    }
  }
}

/**
 * Diagnostic helper. Reads the resolved Brevo config (without
 * exposing the api key) and hits `GET /account` — Brevo returns 200
 * with account metadata if the key is valid, 401 otherwise. Used by
 * /api/admin/email-test to surface "why isn't email working" without
 * having to send a real message.
 */
export async function verifyEmailConnection(): Promise<{
  ok: boolean
  config: {
    provider: "brevo"
    apiKeyConfigured: boolean
    fromAddress: string | null
    fromName: string | null
  }
  error?: string
}> {
  const apiKey = getApiKey()
  const from = getFromAddress()
  const config = {
    provider: "brevo" as const,
    apiKeyConfigured: apiKey != null,
    fromAddress: from?.email ?? null,
    fromName: from?.name ?? null,
  }
  if (!apiKey) {
    return {
      ok: false,
      config,
      error:
        "BREVO_API_KEY not set. Generate one in the Brevo dashboard (SMTP & API → API Keys), add it to .env, and restart the Node process.",
    }
  }
  if (!from) {
    return {
      ok: false,
      config,
      error: "MAIL_FROM_ADDRESS not set. Add it to .env and restart Node.",
    }
  }
  try {
    const response = await fetch(`${BREVO_API_BASE}/account`, {
      headers: { Accept: "application/json", "api-key": apiKey },
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null
      return {
        ok: false,
        config,
        error: body?.message ?? `HTTP ${response.status}`,
      }
    }
    return { ok: true, config }
  } catch (err) {
    return {
      ok: false,
      config,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
