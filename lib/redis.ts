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
    client = new Redis(url, {
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
