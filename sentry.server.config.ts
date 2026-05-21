/**
 * Sentry — server-side SDK.
 *
 * Runs in the Node runtime (server components, API routes, server
 * actions). When `SENTRY_DSN` isn't set the SDK silently disables
 * itself, so this file is safe in dev / CI.
 */
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // 10% transaction tracing in prod is the standard "see latency without
  // breaking the bank" default. Tighten or loosen per investigation.
  tracesSampleRate: 0.1,

  release: process.env.SENTRY_RELEASE,
  environment:
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
})
