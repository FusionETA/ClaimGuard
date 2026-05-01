import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV === "development"

const nextConfig: NextConfig = {
  // Disabled in dev to avoid double-rendering every component (Strict Mode feature).
  // Re-enable before shipping to production to catch side-effect bugs.
  reactStrictMode: !isDev,
  typedRoutes: true,
  allowedDevOrigins: ["192.168.100.71"],
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
