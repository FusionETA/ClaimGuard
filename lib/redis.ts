import "server-only"

import Redis from "ioredis"

/**
 * Redis client (singleton).
 *
 * Behavior is controlled by env vars:
 *   - REDIS_URL          — full connection string. When unset, no client
 *                          is created and `getRedis()` returns `null`.
 *                          The cache layer treats null as "skip cache,
 *                          go straight to the loader" so local dev still
 *                          works without Redis installed.
 *   - REDIS_KEY_PREFIX   — namespace prefix (e.g. "prod:workpulse").
 *                          Every cache key is prepended with
 *                          `${prefix}:` so dev / prod / multiple apps
 *                          can share one Redis without colliding.
 *
 * The connection is lazy — `getRedis()` only creates the client on
 * first call. Connection errors are logged once but don't crash the
 * server: cache helpers degrade gracefully on Redis failures so a
 * misbehaving cache can never take down the app.
 */

let client: Redis | null | undefined
let warnedConnectFail = false

export function getRedis(): Redis | null {
  if (client !== undefined) return client

  const url = process.env.REDIS_URL?.trim()
  if (!url) {
    // Graceful fallback: no Redis configured, cache layer becomes a
    // pass-through. Cached on first call so we don't keep re-reading
    // env on every cache hit.
    client = null
    return null
  }

  try {
    // Parse the URL ourselves with WHATWG URL instead of letting
    // ioredis call Node's deprecated `url.parse()` internally
    // (DEP0169 in Node 22+). Same behavior, no deprecation warning.
    const parsed = parseRedisUrl(url)
    client = new Redis({
      host: parsed.host,
      port: parsed.port,
      db: parsed.db,
      username: parsed.username,
      password: parsed.password,
      tls: parsed.tls,
      // Don't queue commands while disconnected — fail fast so the
      // cache layer can fall back to the loader instead of stalling
      // the request waiting for reconnect.
      enableOfflineQueue: false,
      // Bounded retry — first few attempts are quick, then back off.
      // Keeps ioredis from hammering Redis if it goes down.
      retryStrategy: (times) => Math.min(times * 200, 5_000),
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    })
    client.on("error", (err) => {
      // Log once per process — repeating the same error every retry is
      // pure noise in production logs. Subsequent errors are silently
      // dropped; the cache helpers handle the connection state via
      // try/catch around each call.
      if (!warnedConnectFail) {
        warnedConnectFail = true
        console.warn("[redis] connection error:", err.message)
      }
    })
    return client
  } catch (err) {
    console.warn("[redis] failed to instantiate client:", err)
    client = null
    return null
  }
}

/**
 * Build a fully-prefixed cache key. Keys are case-sensitive and
 * colon-separated by convention. Pass segments individually so the
 * caller doesn't have to remember to join them — `key("org", orgId,
 * "claims", "history")` yields `prod:workpulse:org:abc:claims:history`.
 */
export function key(...segments: Array<string | number>): string {
  const prefix = process.env.REDIS_KEY_PREFIX?.trim() || "workpulse"
  return [prefix, ...segments].join(":")
}

/**
 * Parse a `redis://` or `rediss://` URL using the modern WHATWG `URL`
 * API and project it into the discrete fields ioredis expects. Avoids
 * the legacy `url.parse()` call inside ioredis that triggers
 * Node 22's DEP0169 deprecation warning.
 */
function parseRedisUrl(rawUrl: string): {
  host: string
  port: number
  db: number
  username: string | undefined
  password: string | undefined
  tls: Record<string, never> | undefined
} {
  const u = new URL(rawUrl)

  // Path is "/<db>" or "/" or "". Strip the leading slash and parse;
  // fall back to db 0 when missing or non-numeric.
  const dbFromPath = Number.parseInt(u.pathname.replace(/^\//, ""), 10)
  const db = Number.isFinite(dbFromPath) ? dbFromPath : 0

  // `rediss://` (note the double-s) means TLS. Empty object is the
  // ioredis convention for "use TLS with default settings".
  const tls = u.protocol === "rediss:" ? {} : undefined

  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 6379,
    db,
    // Treat empty strings as "not provided" — ioredis ignores
    // undefined fields, but empty strings would override other auth.
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls,
  }
}
