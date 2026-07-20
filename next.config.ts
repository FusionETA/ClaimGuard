import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV === "development"

/**
 * Build identity, written by `scripts/write-build-id.mjs` during `prebuild`.
 *
 * Feeding this to `deploymentId` makes Next tag static assets and server-action
 * requests with the build they came from. When a tab opened under an older
 * build calls into a newer server, Next sees the mismatch and triggers a full
 * page reload instead of throwing `Failed to find Server Action` /
 * `ChunkLoadError` at the user.
 *
 * Empty string = feature off, which is the correct behaviour in `next dev`
 * (no prebuild runs) and for any checkout that hasn't been built yet.
 */
function readBuildId(): string {
  try {
    return readFileSync(join(process.cwd(), ".build-id"), "utf8").trim()
  } catch {
    return ""
  }
}

const buildId = readBuildId()

const nextConfig: NextConfig = {
  ...(buildId ? { deploymentId: buildId } : {}),
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

export default nextConfig
