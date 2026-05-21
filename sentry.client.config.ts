/**
 * Sentry — browser SDK.
 *
 * Loaded once on the client. When `NEXT_PUBLIC_SENTRY_DSN` isn't set
 * (local dev, CI, fresh clones) `init` becomes a no-op — Sentry's SDK
 * tolerates `dsn: undefined` and silently disables itself, so this file
 * is safe to ship without a DSN configured.
 *
 * Set the DSN in your hosting env (`NEXT_PUBLIC_SENTRY_DSN`) to turn on
 * error capture in production. The `NEXT_PUBLIC_` prefix is required —
 * the browser bundle can only see env vars exposed at build time.
 */
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Performance traces — keep low in prod to control event volume.
  // Bump per-deploy if you're investigating a specific slowdown.
  tracesSampleRate: 0.1,

  // Session replays — capture 0% by default, 100% on sessions that
  // already have a captured error. Lets you actually see what the user
  // did when something broke without ballooning storage cost.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,

  // Filter out noisy errors that aren't actionable.
  ignoreErrors: [
    // Browser extensions throw these all the time.
    "ResizeObserver loop limit exceeded",
    "Non-Error promise rejection captured",
    // Common fetch-aborted errors from the user navigating mid-request.
    "AbortError",
  ],

  // Match the GH SHA from CI so issues group by release.
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  environment:
    process.env.NEXT_PUBLIC_VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development",
})
