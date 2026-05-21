/**
 * Next.js instrumentation hook. Runs once per worker / runtime at boot.
 * Sentry's server SDK is loaded from here in Next 15+ instead of the
 * deprecated `sentry.server.config.ts` auto-import.
 *
 * The dynamic imports keep each runtime's SDK out of the other runtime's
 * bundle (Node code stays out of the Edge bundle and vice versa).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

/**
 * Capture unhandled errors thrown by server components / actions / route
 * handlers and surface them to Sentry. Without this hook, server-side
 * exceptions only land in stdout — the browser-side `error.tsx`
 * boundaries don't see them.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  const Sentry = await import("@sentry/nextjs")
  Sentry.captureRequestError(err, request, context)
}
