import { withSentryConfig } from "@sentry/nextjs"
import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV === "development"

const nextConfig: NextConfig = {
  // Disabled in dev to avoid double-rendering every component (Strict Mode feature).
  // Re-enable before shipping to production to catch side-effect bugs.
  reactStrictMode: !isDev,
  typedRoutes: true,
  allowedDevOrigins: ["192.168.100.71"],
  experimental: {
    // Claim submissions can carry 1 receipt (8 MB) + up to 10 supporting
    // files (8 MB each) — well past Next's 1 MB default. Sized for the
    // worst-case payload the claim form already permits.
    serverActions: { bodySizeLimit: "100mb" },
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
      {
        // iOS Safari needs to cache the apple-touch-startup-image PNGs at
        // install time, otherwise the splash silently fails to appear. The
        // Vercel default of "max-age=0, must-revalidate" was forcing iOS to
        // refetch on every launch and effectively skip the splash.
        source: "/splash/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ]
  },
}

/**
 * Wrap with Sentry. The plugin tunnels client-side traffic through
 * `/monitoring` (ad-blocker safe), uploads source maps to Sentry at
 * build time (so production stack traces are readable), and stays
 * silent when `SENTRY_AUTH_TOKEN` / `SENTRY_DSN` aren't set — meaning
 * local dev and CI builds continue to work without a Sentry account
 * configured.
 */
export default withSentryConfig(nextConfig, {
  // Org + project — only used for source-map upload at build time. Safe
  // to commit; the secret is `SENTRY_AUTH_TOKEN` (env-only).
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Suppress build-time output from the Sentry plugin when there's
  // nothing to upload (no auth token configured).
  silent: !process.env.SENTRY_AUTH_TOKEN,

  // Source-map upload runs only when both DSN and auth token are set.
  // Otherwise the plugin no-ops cleanly.
  widenClientFileUpload: true,

  // Route browser → Sentry traffic through your own domain so it
  // survives ad-blockers. Optional but recommended.
  tunnelRoute: "/monitoring",

  // Strip console.* calls from the production bundle by default; the
  // browser SDK already breadcrumbs them for Sentry.
  disableLogger: true,
})
