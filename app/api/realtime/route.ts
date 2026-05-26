import { getCurrentSession } from "@/lib/auth/session"
import { getRedis } from "@/lib/redis"
import { userChannel } from "@/lib/realtime"

/**
 * GET /api/realtime — Server-Sent Events stream for the logged-in user.
 *
 * Opens a long-lived connection (fine on our DigitalOcean droplet — a
 * persistent Node process, not serverless) and subscribes to the user's
 * Redis pub/sub channel. Server code publishes events via
 * `publishUserEvent` (see lib/realtime.ts); each one is forwarded down
 * this stream as an SSE `data:` frame. The client (RealtimeListener)
 * reacts by refreshing the page + the notification bell.
 *
 * A dedicated subscriber connection (ioredis `.duplicate()`) is used
 * because a connection in subscribe mode can't run normal commands.
 */

// Long-lived stream — never statically optimised, always Node runtime
// (ioredis needs Node APIs, not the Edge runtime).
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Heartbeat so proxies/load balancers don't kill an idle connection and
// the browser notices a dead stream quickly.
const PING_INTERVAL_MS = 25_000

export async function GET(request: Request): Promise<Response> {
  const session = await getCurrentSession()
  if (!session) {
    return new Response("Unauthorized", { status: 401 })
  }

  const base = getRedis()
  if (!base) {
    // No Redis configured — realtime is unavailable; client falls back
    // to its existing polling.
    return new Response("Realtime unavailable", { status: 503 })
  }

  const channel = userChannel(session.userId)
  // Subscriber connection needs its own options — subscribe mode must
  // not cap retries-per-request the way the shared command client does.
  const sub = base.duplicate({
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  })

  const encoder = new TextEncoder()
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  function cleanup() {
    if (closed) return
    closed = true
    if (pingTimer) clearInterval(pingTimer)
    sub.removeAllListeners("message")
    sub.unsubscribe(channel).catch(() => {})
    sub.quit().catch(() => {})
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(frame: string) {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          cleanup()
        }
      }

      // Open the stream immediately so the client's `onopen` fires.
      send(`: connected\n\n`)

      sub.on("message", (_ch, message) => {
        send(`data: ${message}\n\n`)
      })

      try {
        await sub.subscribe(channel)
      } catch {
        // Couldn't subscribe — close cleanly; client will retry/poll.
        cleanup()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        return
      }

      pingTimer = setInterval(() => send(`: ping\n\n`), PING_INTERVAL_MS)
    },
    cancel() {
      cleanup()
    },
  })

  // Browser navigated away / closed the tab.
  request.signal.addEventListener("abort", cleanup)

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable nginx/proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  })
}
