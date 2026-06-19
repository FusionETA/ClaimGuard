import "server-only"

import { normalisePhone, sendWhatsApp } from "@/lib/whatsapp"

/**
 * Critical error notifier — sends WhatsApp via Wazzup24 when something
 * blows up in production. Replaces the old Sentry forwarder.
 *
 * Coverage scope (Level 2 + 3 + 5 from the design conversation):
 *   - **Server-side only** — client error boundaries don't reach this.
 *     We avoid exposing an /api/error-notify endpoint that browser
 *     extensions could spam.
 *   - **Critical only** — only `log.critical(...)` events flow here.
 *     `log.error(...)` stays stdout-only. Engineers explicitly tag
 *     must-alert errors (and `instrumentation.ts onRequestError`
 *     auto-tags as critical because an unhandled server exception
 *     already crashed the request).
 *   - **Production only** — skipped when `NODE_ENV !== "production"`
 *     so dev / CI / preview deploys don't ping the on-call phone.
 *
 * Wiring:
 *   1. Server boot (`instrumentation.ts`) calls
 *      `registerCriticalNotifier()` which plants a hook on
 *      `globalThis.__criticalNotify`.
 *   2. `lib/log.ts` (universal — runs on both server and client) calls
 *      `globalThis.__criticalNotify?.(event, fields)` from
 *      `log.critical(...)`. On the client the hook is undefined and the
 *      call is a no-op; on the server it routes to `notifyCritical`.
 *   3. `notifyCritical` rate-limits, formats a short WhatsApp message,
 *      and fires one send per recipient phone via `lib/whatsapp.ts`.
 *
 * Env vars (all optional — missing ones gracefully degrade):
 *   WAZZUP_ERROR_NOTIFY_PHONES   - Comma-separated list of recipient
 *                                  phone numbers in digits-only
 *                                  international format
 *                                  ("60123456789,60198765432"). Empty
 *                                  → no-op + console warn.
 *   WAZZUP_API_KEY, _CHANNEL_ID  - Required by sendWhatsApp; same vars
 *                                  the password-reset OTP already uses.
 *
 * NEVER throws — `void notifyCritical(...)` is fire-and-forget by
 * design. A broken notifier must not turn a request that already
 * crashed into a worse crash, and downstream `void` callers expect a
 * no-throw contract.
 */

type LogFields = Record<string, unknown>
type CriticalNotifyHook = (event: string, fields?: LogFields) => void

declare global {
  // eslint-disable-next-line no-var
  var __criticalNotify: CriticalNotifyHook | undefined
}

// In-memory dedupe state. Per-process (each Vercel function invocation
// has its own memory), so the worst case is duplicate sends across
// instances — which is fine when the alternative is dropping nothing.
const recentlySeen = new Map<string, number>()
const DEDUPE_WINDOW_MS = 5 * 60 * 1000
const MAX_TRACKED = 200

function getRecipients(): string[] {
  const raw = process.env.WAZZUP_ERROR_NOTIFY_PHONES?.trim()
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => normalisePhone(s.trim()))
    .filter((s): s is string => s !== null)
}

function dedupeKey(event: string, fields: LogFields | undefined): string {
  const err = fields?.err
  if (err instanceof Error) {
    const firstStackFrame = (err.stack ?? "").split("\n")[1] ?? ""
    return `${event}|${err.message}|${firstStackFrame.trim()}`
  }
  return event
}

function pruneStale(now: number) {
  if (recentlySeen.size <= MAX_TRACKED) return
  const cutoff = now - DEDUPE_WINDOW_MS
  for (const [k, t] of recentlySeen) {
    if (t < cutoff) recentlySeen.delete(k)
  }
}

function formatMessage(
  event: string,
  fields: LogFields | undefined,
  env: string,
): string {
  const lines: string[] = []
  lines.push(`🚨 ${event}`)
  lines.push(`env: ${env}`)
  if (typeof fields?.userId === "string") lines.push(`user: ${fields.userId}`)
  if (typeof fields?.route === "string") lines.push(`route: ${fields.route}`)
  if (typeof fields?.path === "string") lines.push(`path: ${fields.path}`)
  if (typeof fields?.method === "string") lines.push(`method: ${fields.method}`)

  const err = fields?.err
  if (err instanceof Error) {
    lines.push("")
    lines.push(`${err.name}: ${err.message}`)
    if (err.stack) {
      const stack = err.stack.split("\n").slice(0, 6).join("\n")
      lines.push("")
      lines.push(stack)
    }
  } else if (fields) {
    const reserved = new Set([
      "userId",
      "route",
      "path",
      "method",
      "err",
      "level",
      "event",
      "ts",
    ])
    const extras = Object.entries(fields)
      .filter(([k]) => !reserved.has(k))
      .slice(0, 5)
    if (extras.length) {
      lines.push("")
      for (const [k, v] of extras) {
        const s =
          typeof v === "string" ? v : (() => {
            try {
              return JSON.stringify(v)
            } catch {
              return String(v)
            }
          })()
        lines.push(`${k}: ${s.slice(0, 100)}`)
      }
    }
  }

  // WhatsApp accepts ~4096 chars in one message but anything past ~900
  // gets unwieldy on a phone — keep it terse so it's actually readable.
  return lines.join("\n").slice(0, 900)
}

async function notifyCritical(
  event: string,
  fields: LogFields | undefined,
): Promise<void> {
  if (process.env.NODE_ENV !== "production") return

  const recipients = getRecipients()
  if (recipients.length === 0) {
    console.warn(
      "[error-notify] WAZZUP_ERROR_NOTIFY_PHONES is empty — critical event not sent:",
      event,
    )
    return
  }

  const now = Date.now()
  const key = dedupeKey(event, fields)
  const seen = recentlySeen.get(key)
  if (seen && now - seen < DEDUPE_WINDOW_MS) return
  recentlySeen.set(key, now)
  pruneStale(now)

  const env =
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown"
  const text = formatMessage(event, fields, env)

  // Fan out one send per recipient. Fire-and-forget — sendWhatsApp
  // already swallows its own errors and returns { delivered: false, ... }
  // so we only need a final catch in case the SDK module itself throws.
  for (const to of recipients) {
    sendWhatsApp({ to, text }).catch((err) => {
      console.error("[error-notify] send failed", { to, err })
    })
  }
}

export function registerCriticalNotifier(): void {
  globalThis.__criticalNotify = (event, fields) => {
    void notifyCritical(event, fields)
  }
}
