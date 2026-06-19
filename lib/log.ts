/**
 * Tiny structured logger.
 *
 * Writes one JSON line per event to stdout. Production log aggregators
 * (cPanel logs, Better Stack, Datadog, etc.) can parse these straight
 * out of the container/process log without any extra setup.
 *
 * Why one line of JSON instead of `console.log("...")` strings?
 *   - Greppable: `cat log | jq 'select(.level=="error")'`.
 *   - Stable schema: `event`, `level`, `userId`, `route`, `latencyMs`,
 *     plus whatever ad-hoc fields the caller passes.
 *   - Never throws — logging must not be load-bearing. A bad payload
 *     falls back to a plain console call.
 *
 * Usage:
 *   import { log } from "@/lib/log"
 *   log.info("ocr.analyze.start", { userId, orgId })
 *   log.error("ocr.analyze.failed", { userId, err })   // stdout only
 *   log.critical("payroll.calc.crashed", { runId, err }) // → WhatsApp
 *
 * `log.critical` is the must-alert tier — server-side critical events
 * route to a WhatsApp notifier (production only). `log.error` stays
 * stdout-only. See `lib/error-notify.ts` for the dispatch hook.
 *
 * Pure / browser-safe — no node-only APIs. Anything in `lib/` must work
 * on both sides per lib/CLAUDE.md.
 */

type Level = "debug" | "info" | "warn" | "error" | "critical"

type LogFields = Record<string, unknown>

/**
 * The critical-event notifier is registered server-side at boot
 * (`instrumentation.ts` → `registerCriticalNotifier()`). On the client
 * this global stays undefined and the forward is a silent no-op, which
 * matches our Level-2 design: only server-side criticals page.
 */
type CriticalNotifyHook = (event: string, fields?: LogFields) => void
declare global {
  // eslint-disable-next-line no-var
  var __criticalNotify: CriticalNotifyHook | undefined
}

function forwardToCriticalNotifier(event: string, fields?: LogFields) {
  try {
    globalThis.__criticalNotify?.(event, fields)
  } catch {
    /* notifier must not break the calling request */
  }
}

function emit(level: Level, event: string, fields?: LogFields) {
  try {
    const payload: Record<string, unknown> = {
      level,
      event,
      ts: new Date().toISOString(),
      ...fields,
    }

    // Errors don't serialize via JSON.stringify by default — pull name,
    // message, and stack into plain fields so they actually land in the log.
    if (fields?.err instanceof Error) {
      payload.err = {
        name: fields.err.name,
        message: fields.err.message,
        stack: fields.err.stack,
      }
    }

    const line = JSON.stringify(payload)
    if (level === "error" || level === "warn" || level === "critical") {
      console.error(line)
    } else {
      console.log(line)
    }

    // Critical events also fan out to WhatsApp via the server-side
    // notifier. `log.error` is stdout-only by design (Level-3 scope):
    // engineers explicitly opt in to phone alerts by calling
    // `log.critical(...)` for the must-alert subset.
    if (level === "critical") {
      forwardToCriticalNotifier(event, fields)
    }
  } catch {
    // Last-ditch fallback — never let logging break the request.
    console.log(`[log:${level}] ${event}`)
  }
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
  critical: (event: string, fields?: LogFields) =>
    emit("critical", event, fields),
}
