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
    ]
  },
}

export default nextConfig
