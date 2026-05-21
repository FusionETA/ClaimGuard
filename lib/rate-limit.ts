import { getRedis, key } from "@/lib/redis"

/**
 * Fixed-window rate limiter backed by Redis INCR + EXPIRE.
 *
 * Behaviour:
 *   - First request in a window creates the counter and sets a TTL.
 *   - Every subsequent request increments. Once the counter exceeds
 *     `max`, the limiter returns `{ ok: false, ... }` until the window
 *     expires.
 *   - When Redis is unavailable (local dev without REDIS_URL, or a
 *     transient outage), the limiter fails OPEN — i.e. the request is
 *     allowed. This matches the rest of the cache layer's "Redis is
 *     never load-bearing" policy. If you ever need fail-closed semantics
 *     for a specific route, gate it explicitly.
 *
 * Usage in a route handler:
 *
 *   const rl = await rateLimit({ scope: "ocr", id: session.userId, max: 20, windowSec: 60 })
 *   if (!rl.ok) {
 *     return NextResponse.json(
 *       { error: "Too many requests. Try again shortly." },
 *       { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
 *     )
 *   }
 */

export type RateLimitResult =
  | { ok: true; remaining: number; limit: number }
  | { ok: false; retryAfterSec: number; limit: number }

export type RateLimitInput = {
  /** Logical bucket name, e.g. "ocr" or "push:subscribe". */
  scope: string
  /** Per-actor identifier (user id, IP, etc.). */
  id: string
  /** Maximum allowed requests within the window. */
  max: number
  /** Window length in seconds. */
  windowSec: number
}

export async function rateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const { scope, id, max, windowSec } = input
  const redis = getRedis()

  // Fail open when Redis isn't configured — see comment above.
  if (!redis) {
    return { ok: true, remaining: max, limit: max }
  }

  const cacheKey = key("ratelimit", scope, id)

  try {
    const count = await redis.incr(cacheKey)
    if (count === 1) {
      // First hit in a fresh window — set the TTL.
      await redis.expire(cacheKey, windowSec)
    }

    if (count > max) {
      // Best-effort: read remaining TTL so the client knows when to retry.
      let ttl = await redis.ttl(cacheKey)
      if (ttl < 0) ttl = windowSec
      return { ok: false, retryAfterSec: ttl, limit: max }
    }

    return { ok: true, remaining: Math.max(0, max - count), limit: max }
  } catch {
    // Transient Redis error — fail open.
    return { ok: true, remaining: max, limit: max }
  }
}
