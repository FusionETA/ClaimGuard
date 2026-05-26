"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

/**
 * Mounts a single Server-Sent Events connection to `/api/realtime` for
 * the logged-in user (rendered once inside each portal shell). When the
 * server publishes an event — e.g. a claim was submitted/approved and a
 * notification was created for this user — we:
 *
 *   1. `router.refresh()` so server components re-fetch (the supervisor
 *      approval queue updates: new items appear, approved ones leave).
 *   2. Dispatch a `altomate:realtime` window event so the notification
 *      bell reloads its count/list immediately (instead of its 45s poll).
 *
 * EventSource auto-reconnects on drop. When Redis isn't configured the
 * route returns 503 and the browser stops retrying that error — the bell
 * just falls back to polling. Safe no-op in that case.
 */
export function RealtimeListener() {
  const router = useRouter()
  // Debounce a burst of events into one refresh (e.g. several
  // notifications created in the same request).
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let es: EventSource | null = null
    let stopped = false

    function scheduleRefresh() {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        router.refresh()
        window.dispatchEvent(new CustomEvent("altomate:realtime"))
      }, 150)
    }

    function connect() {
      if (stopped) return
      es = new EventSource("/api/realtime", { withCredentials: true })
      es.onmessage = () => scheduleRefresh()
      es.onerror = () => {
        // On a hard error the browser keeps retrying automatically; we
        // only intervene to avoid a tight loop if the endpoint is gone.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close()
          if (!stopped) setTimeout(connect, 10_000)
        }
      }
    }

    connect()

    return () => {
      stopped = true
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      es?.close()
    }
  }, [router])

  return null
}
