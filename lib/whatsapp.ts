import "server-only"

/**
 * Transactional WhatsApp via Wazzup24's HTTP API. Used by the employee
 * password-reset flow to deliver the 6-digit code.
 *
 * Why HTTP + Wazzup24 instead of WhatsApp Business API directly?
 * Direct WhatsApp BSP onboarding (Meta tech-provider review) takes
 * weeks. Wazzup24 is already a registered tech provider so we can
 * start sending the same day — they handle channel registration and
 * template review on their side.
 *
 * Required env vars:
 *   WAZZUP_API_KEY                - Bearer token from Wazzup dashboard
 *                                   (Settings → API).
 *   WAZZUP_CHANNEL_ID             - UUID of the WhatsApp channel to
 *                                   send from. Visible in
 *                                   Settings → Channels.
 *   WAZZUP_DEFAULT_COUNTRY_CODE   - optional (defaults to "60" for
 *                                   Malaysia). Prepended to numbers
 *                                   stored in local format (those
 *                                   starting with "0").
 *
 * When env vars are missing, sendWhatsApp logs the would-be-sent
 * payload and returns { delivered: false } without throwing. Lets
 * local dev work without provider creds; production must always
 * have these configured.
 */

const WAZZUP_API_BASE = "https://api.wazzup24.com/v3"

function getApiKey(): string | null {
  const k = process.env.WAZZUP_API_KEY?.trim()
  return k && k.length > 0 ? k : null
}

function getChannelId(): string | null {
  const c = process.env.WAZZUP_CHANNEL_ID?.trim()
  return c && c.length > 0 ? c : null
}

function getDefaultCountryCode(): string {
  return process.env.WAZZUP_DEFAULT_COUNTRY_CODE?.trim() || "60"
}

/**
 * Normalise a phone number to the digits-only international format
 * Wazzup expects ("60123456789", not "+60 12-345 6789").
 *
 * Rules:
 *   - Strip every non-digit character.
 *   - Empty input → null (caller should treat as "no phone").
 *   - If the result starts with "0" we assume legacy Malaysian local
 *     format (012-345 6789) and replace the leading "0" with the
 *     default country code.
 *   - Otherwise assume the number already carries its country code
 *     (60, 1, 44, etc.) and leave it alone.
 */
export function normalisePhone(
  input: string | null | undefined,
): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, "")
  if (digits.length === 0) return null
  if (digits.startsWith("0")) {
    return getDefaultCountryCode() + digits.slice(1)
  }
  return digits
}

export type SendWhatsAppInput = {
  /// Phone number — pass through `normalisePhone()` first.
  to: string
  /// Plain text body (no markdown). Free-form messages only land in
  /// the 24-hour customer window; for cold contact you need a
  /// pre-approved template. Wazzup will reject with an error in that
  /// case and the caller can decide what to do.
  text: string
}

export async function sendWhatsApp(
  input: SendWhatsAppInput,
): Promise<{ delivered: boolean; messageId?: string; reason?: string }> {
  const apiKey = getApiKey()
  const channelId = getChannelId()
  if (!apiKey || !channelId) {
    console.warn(
      "[whatsapp] Wazzup not configured — would have sent:",
      JSON.stringify(
        { to: input.to, snippet: input.text.slice(0, 200) },
        null,
        2,
      ),
    )
    return {
      delivered: false,
      reason: !apiKey ? "wazzup-key-missing" : "channel-id-missing",
    }
  }
  try {
    const response = await fetch(`${WAZZUP_API_BASE}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        channelId,
        chatType: "whatsapp",
        chatId: input.to,
        text: input.text,
      }),
    })
    if (!response.ok) {
      // Wazzup returns { error, message, ... } on 4xx. Surface the
      // message so the diagnostic endpoint shows the real reason
      // ("invalid channelId", "phone not on whatsapp", etc.).
      const body = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null
      return {
        delivered: false,
        reason: body?.message ?? body?.error ?? `HTTP ${response.status}`,
      }
    }
    const body = (await response.json().catch(() => null)) as
      | { messageId?: string }
      | null
    return { delivered: true, messageId: body?.messageId }
  } catch (err) {
    console.error("[whatsapp] send failed:", err)
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : "send-failed",
    }
  }
}

/**
 * Diagnostic helper. Reads the resolved Wazzup config (without
 * exposing the api key) and hits `GET /channels` — Wazzup returns the
 * list of channels on the account if the key is valid, 401 / 403
 * otherwise. Used by /api/admin/whatsapp-test to verify the auth +
 * confirm WAZZUP_CHANNEL_ID is a channel that exists on the account.
 */
export async function verifyWhatsAppConnection(): Promise<{
  ok: boolean
  config: {
    provider: "wazzup24"
    apiKeyConfigured: boolean
    channelIdConfigured: boolean
    channelId: string | null
    defaultCountryCode: string
  }
  error?: string
}> {
  const apiKey = getApiKey()
  const channelId = getChannelId()
  const config = {
    provider: "wazzup24" as const,
    apiKeyConfigured: apiKey != null,
    channelIdConfigured: channelId != null,
    channelId,
    defaultCountryCode: getDefaultCountryCode(),
  }
  if (!apiKey) {
    return {
      ok: false,
      config,
      error:
        "WAZZUP_API_KEY not set. Generate one in the Wazzup dashboard (Settings → API), add it to .env, and restart Node.",
    }
  }
  if (!channelId) {
    return {
      ok: false,
      config,
      error:
        "WAZZUP_CHANNEL_ID not set. Copy the channel UUID from Settings → Channels in the Wazzup dashboard.",
    }
  }
  try {
    const response = await fetch(`${WAZZUP_API_BASE}/channels`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null
      return {
        ok: false,
        config,
        error: body?.message ?? body?.error ?? `HTTP ${response.status}`,
      }
    }
    const channels = (await response.json().catch(() => null)) as
      | Array<{ channelId?: string; transport?: string; state?: string }>
      | null
    if (!Array.isArray(channels)) {
      return {
        ok: false,
        config,
        error: "Unexpected response shape from Wazzup /channels.",
      }
    }
    const found = channels.find((c) => c.channelId === channelId)
    if (!found) {
      return {
        ok: false,
        config,
        error: `Channel ${channelId} not found on this Wazzup account. Available channels: ${channels.map((c) => c.channelId).filter(Boolean).join(", ") || "(none)"}.`,
      }
    }
    if (found.state && found.state !== "active") {
      return {
        ok: false,
        config,
        error: `Channel ${channelId} state is "${found.state}" (expected "active"). Re-authenticate the channel in the Wazzup dashboard.`,
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
