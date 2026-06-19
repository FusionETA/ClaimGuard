import { log } from "@/lib/log"

/**
 * Next.js instrumentation hook. Runs once per worker / runtime at boot.
 *
 * Plants the critical-event notifier on `globalThis.__criticalNotify`
 * so any subsequent `log.critical(...)` call on this process fans out
 * to WhatsApp via Wazzup24. See `lib/error-notify.ts` for the dedupe
 * + production-only gating.
 *
 * Dynamic import keeps the server-only notifier module out of any
 * runtime bundle that wouldn't need it (Edge picks up its own copy
 * separately — the registration is idempotent).
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" ||
    process.env.NEXT_RUNTIME === "edge"
  ) {
    const { registerCriticalNotifier } = await import("@/lib/error-notify")
    registerCriticalNotifier()
  }
}

/**
 * Capture unhandled errors thrown by server components / actions /
 * route handlers and route them through the critical-notifier pipeline.
 * Unhandled = the request already crashed, so it's always must-alert
 * material — no need for the caller to explicitly tag.
 */
export async function onRequestError(
  err: unknown,
  request: {
    path: string
    method: string
    headers: Record<string, string | string[] | undefined>
  },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  log.critical("request.unhandled_error", {
    err,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeKind: context.routerKind,
    routeType: context.routeType,
  })
}
