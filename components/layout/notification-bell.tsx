"use client"

import type { Route } from "next"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { Bell, Check, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import type { NotificationView } from "@/modules/notifications/domain/models"

const POLL_INTERVAL_MS = 45_000

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diffMs = Date.now() - then
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function NotificationBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<NotificationView[]>([])
  const [unread, setUnread] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback((signal?: AbortSignal) => {
    return fetch("/api/notifications", {
      cache: "no-store",
      credentials: "include",
      signal,
    })
      .then(async (res) => {
        if (!res.ok) return null
        return res.json() as Promise<{
          notifications: NotificationView[]
          unreadCount: number
        }>
      })
      .then((data) => {
        if (!data) return
        setItems(data.notifications)
        setUnread(data.unreadCount)
      })
      .catch(() => null)
  }, [])

  // Initial fetch + polling.
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const id = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => {
      controller.abort()
      window.clearInterval(id)
    }
  }, [load])

  // Live updates: reload immediately when the realtime listener
  // (SSE) reports a change, instead of waiting for the 45s poll.
  useEffect(() => {
    function onRealtime() {
      void load()
    }
    window.addEventListener("altomate:realtime", onRealtime)
    return () => window.removeEventListener("altomate:realtime", onRealtime)
  }, [load])

  // Refresh the list when the dropdown is opened.
  useEffect(() => {
    if (open) {
      setLoading(true)
      void load().finally(() => setLoading(false))
    }
  }, [open, load])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onPointer(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  async function markRead(id: string) {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    )
    setUnread((u) => Math.max(0, u - 1))
    await fetch("/api/notifications/read", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null)
  }

  async function markAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnread(0)
    await fetch("/api/notifications/read", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => null)
  }

  function handleItemClick(n: NotificationView) {
    if (!n.read) void markRead(n.id)
    setOpen(false)
    if (n.url) router.push(n.url as Route)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-card/90 text-muted-foreground shadow-ambient transition-colors hover:text-foreground"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-border/60 bg-card shadow-panel">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <p className="text-sm font-bold">Notifications</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                <Check className="h-3.5 w-3.5" />
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No notifications yet.
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => handleItemClick(n)}
                      className={cn(
                        "flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-surface-low",
                        !n.read && "bg-primary/5",
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {n.title}
                        </span>
                        {!n.read ? (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                        ) : null}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {n.body}
                      </span>
                      <span className="text-xs text-muted-foreground/70">
                        {formatRelativeTime(n.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
