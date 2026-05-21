/**
 * Sentry — Edge runtime SDK.
 *
 * Used by middleware and any route configured with `runtime: "edge"`.
 * Smaller surface than the Node SDK; same no-op-when-DSN-unset behavior.
 */
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  release: process.env.SENTRY_RELEASE,
  environment:
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
})
