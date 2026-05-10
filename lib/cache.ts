import "server-only"

import { getRedis } from "@/lib/redis"

/**
 * Read-through cache helper. Returns the cached value if present;
 * otherwise calls `loader()`, stores the result with TTL, and returns
 * it. When Redis is unavailable (no REDIS_URL, connection failure,
 * etc.), short-circuits to the loader — the app stays correct, just
 * uncached.
 *
 * Key naming convention (use `key()` from `lib/redis.ts`):
 *   `<prefix>:org:<orgId>:<feature>:<...specifier>`
 *
 * TTL guidance:
 *   - Reference data (projects, chart accounts):  600s  (10 min)
 *   - Page-data services (dashboard, queues):      60s  (1 min)
 *   - Per-user history lists:                      60s  (1 min)
 *
 * The TTL is a backstop. We invalidate explicitly on every mutation
 * (see `deleteCache` + the action-layer wiring). TTL just bounds the
 * stale-data window when an invalidation is missed.
 */
export async function getOrSetCache<T>(
  fullKey: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const redis = getRedis()

  // No Redis configured (local dev without REDIS_URL) — pass through.
  if (!redis) return loader()

  try {
    const hit = await redis.get(fullKey)
    if (hit !== null) {
      // Cache hit. JSON parse — if a value was stored that isn't
      // round-trippable JSON, we treat it as a miss rather than crash.
      try {
        return JSON.parse(hit) as T
      } catch {
        // Corrupted entry — drop it and reload from source.
        await redis.del(fullKey).catch(() => {})
      }
    }
  } catch (err) {
    // Read failed (connection drop, timeout, etc.). Log once-ish via
    // the redis client's own error handler; here we just fall through
    // to the loader so the request still succeeds.
  }

  const value = await loader()

  // Best-effort write. Ignore failures — we already have the answer
  // for this request; subsequent requests will just miss again.
  try {
    await redis.set(fullKey, JSON.stringify(value), "EX", ttlSeconds)
  } catch {
    /* swallow */
  }

  return value
}

/**
 * Delete a single key OR every key matching a glob pattern. Use
 * patterns like `prefix:org:abc:claims:*` to nuke a whole feature
 * slice on mutation.
 *
 * SCAN is used instead of KEYS because KEYS blocks the Redis event
 * loop on large keyspaces — fine in dev, dangerous in prod. SCAN
 * iterates in chunks so we never hold the server hostage.
 *
 * No-op when Redis isn't configured.
 */
export async function deleteCache(keyOrPattern: string): Promise<void> {
  const redis = getRedis()
  if (!redis) return

  // Plain key (no glob chars) — single DEL is fastest.
  if (!/[*?[\]]/.test(keyOrPattern)) {
    try {
      await redis.del(keyOrPattern)
    } catch {
      /* swallow */
    }
    return
  }

  // Glob pattern — SCAN + batched DEL.
  try {
    let cursor = "0"
    do {
      const [next, batch] = await redis.scan(
        cursor,
        "MATCH",
        keyOrPattern,
        "COUNT",
        200,
      )
      cursor = next
      if (batch.length > 0) {
        // UNLINK is async on the server side — preferred over DEL for
        // pattern busts because it doesn't block the event loop while
        // freeing memory. Falls back to DEL on older Redis versions.
        try {
          await redis.unlink(...batch)
        } catch {
          await redis.del(...batch).catch(() => {})
        }
      }
    } while (cursor !== "0")
  } catch {
    /* swallow */
  }
}

/**
 * Delete several keys/patterns in parallel. Sugar around
 * `deleteCache` so callers can write a one-liner at the bottom of an
 * action: `await deleteCacheMany([key1, "prefix:foo:*", key3])`.
 */
export async function deleteCacheMany(
  keysOrPatterns: ReadonlyArray<string>,
): Promise<void> {
  await Promise.all(keysOrPatterns.map(deleteCache))
}
