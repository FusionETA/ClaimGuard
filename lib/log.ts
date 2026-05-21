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
 *   log.error("ocr.analyze.failed", { userId, err })
 *
 * Pure / browser-safe — no node-only APIs. Anything in `lib/` must work
 * on both sides per lib/CLAUDE.md.
 */

type Level = "debug" | "info" | "warn" | "error"

type LogFields = Record<string, unknown>

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
    if (level === "error" || level === "warn") {
      console.error(line)
    } else {
      console.log(line)
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
}
