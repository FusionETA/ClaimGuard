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
 * Heuristic: does this request path look like a vulnerability scanner /
 * bot probe rather than a real app route?
 *
 * Bots spray POSTs at made-up paths hoping to trip a Next.js Server
 * Action exploit — e.g. `POST /RSC/xxwest6ncl3rxi5.txt`. The tell is the
 * file extension: real Server Action / route-handler POSTs target page
 * routes, which never end in a static-file extension. So a POST to
 * anything ending in `.txt`, `.php`, `.env`, `.xml`, etc. is junk.
 */
function isLikelyBotPath(path: string): boolean {
  // Drop any query string, then check for a trailing file extension.
  const pathname = path.split("?")[0]
  return /\.[a-z0-9]{1,8}$/i.test(pathname)
}

/**
 * Errors that are caused by the *incoming request*, not by our code, and
 * so are never worth paging on-call about:
 *
 *   1. `TypeError: Failed to parse body as FormData` — undici choked on a
 *      garbage / non-multipart body. Always a malformed request.
 *   2. `Error: Failed to find Server Action …` — the request referenced a
 *      Server Action ID that isn't in the live build. Either a scanner
 *      sending a made-up ID, or post-deploy version skew: a real user whose
 *      tab predates the current build clicked something. Skew is an expected
 *      consequence of every deploy, isn't actionable while it's happening,
 *      and clears itself on refresh — so it is never page-worthy, on any
 *      path. (It IS still a real papercut for that user; the fix is
 *      `deploymentId` + a guarded reload, not an alert.)
 *
 * Returns true only for noise we should downgrade to a stdout-only
 * `log.error` (no WhatsApp). Error (1) is noise on scanner paths; error (2)
 * is always noise.
 */
function isRequestNoise(err: unknown, path: string): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message

  const malformedBody =
    msg.includes("parse body as FormData") ||
    msg.includes("parse content as FormData") ||
    msg.includes("Unexpected end of form")

  const missingServerAction = msg.includes("Failed to find Server Action")

  if (malformedBody) return isLikelyBotPath(path)
  if (missingServerAction) return true
  return false
}

/**
 * Capture unhandled errors thrown by server components / actions /
 * route handlers and route them through the notifier pipeline.
 * Unhandled = the request already crashed, so it's normally must-alert
 * material — except for scanner/bot noise (see `isRequestNoise`), which is
 * downgraded to a stdout-only `log.error` so probes can't page on-call.
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
  const level = isRequestNoise(err, request.path) ? log.error : log.critical
  level("request.unhandled_error", {
    err,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeKind: context.routerKind,
    routeType: context.routeType,
  })
}
