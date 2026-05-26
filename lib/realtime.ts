import "server-only"

import { getRedis, key } from "@/lib/redis"

/**
 * Realtime (SSE) fan-out over Redis pub/sub.
 *
 * Each connected browser opens an EventSource to `/api/realtime`, which
 * subscribes to that user's channel. Server code publishes small events
 * to a user's channel; every open connection for that user (on any
 * server instance) receives it and the client reacts — refreshing the
 * supervisor approval queue and the notification bell.
 *
 * The payload is intentionally tiny: the client treats almost any event
 * as "something changed, re-fetch" (router.refresh + bell reload). We
 * still send a `type` so future clients can filter if needed.
 *
 * Like the cache layer, this degrades gracefully: when Redis isn't
 * configured (`getRedis()` returns null) publishing is a no-op and the
 * app keeps working — just without live updates.
 */

export type RealtimeEventType = "notification" | "claim" | "refresh"

export type RealtimeEvent = {
  type: RealtimeEventType
  /** Optional hint for the client (e.g. which surface to refresh). */
  scope?: string
  /** Server timestamp (ms) — handy for de-duping/debugging on the client. */
  at?: number
}

/** Redis pub/sub channel for one user's realtime events. */
export function userChannel(userId: string): string {
  return key("rt", "user", userId)
}

/** Publish a realtime event to a single user's channel. Best-effort. */
export async function publishUserEvent(
  userId: string,
  event: RealtimeEvent,
): Promise<void> {
  const redis = getRedis()
  if (!redis || !userId) return
  try {
    await redis.publish(
      userChannel(userId),
      JSON.stringify({ at: Date.now(), ...event }),
    )
  } catch {
    // Never let a realtime publish failure break the request that
    // triggered it — live updates are a nicety, not a correctness path.
  }
}

/** Publish the same event to many users (deduped). Best-effort. */
export async function publishUserEvents(
  userIds: string[],
  event: RealtimeEvent,
): Promise<void> {
  const unique = Array.from(new Set(userIds.filter(Boolean)))
  if (unique.length === 0) return
  await Promise.all(unique.map((id) => publishUserEvent(id, event)))
}
