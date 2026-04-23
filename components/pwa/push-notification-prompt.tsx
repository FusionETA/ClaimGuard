"use client"

import { useEffect, useState } from "react"
import { BellRing, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toaster"
import {
  hasPushSubscription,
  pushNotificationsSupported,
  subscribeToPushNotifications,
} from "@/lib/push-notifications"

export function PushNotificationPrompt() {
  const { toast } = useToast()
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    let active = true

    async function checkState() {
      if (!pushNotificationsSupported()) {
        return
      }

      if (Notification.permission === "denied") {
        if (active) {
          setBlocked(true)
          setVisible(true)
        }
        return
      }

      const subscribed = await hasPushSubscription().catch(() => false)

      if (!active || subscribed) {
        return
      }

      setVisible(true)
    }

    void checkState()

    return () => {
      active = false
    }
  }, [])

  if (!visible) {
    return null
  }

  return (
    <div className="px-4 pb-4 lg:hidden">
      <div className="rounded-[28px] border border-border/70 bg-card/94 p-4 shadow-ambient backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <BellRing className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold text-foreground">Turn on claim alerts</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {blocked
                ? "Notifications are blocked on this phone. Re-enable them in browser settings if you want claim alerts."
                : "Enable notifications so new submissions and review updates reach you instantly."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setVisible(false)}
            className="rounded-full p-1 text-muted-foreground transition hover:bg-surface-low hover:text-foreground"
            aria-label="Dismiss notification prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!blocked ? (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              className="rounded-2xl"
              disabled={loading}
              onClick={async () => {
                setLoading(true)
                const result = await subscribeToPushNotifications().catch(() => ({
                  ok: false as const,
                  reason: "subscribe-failed",
                }))
                setLoading(false)

                if (result.ok) {
                  toast({ title: "Notifications enabled for this device.", variant: "success" })
                  setVisible(false)
                  return
                }

                if (result.reason === "denied") {
                  setBlocked(true)
                  toast({ title: "Notifications were blocked on this device.", variant: "error" })
                  return
                }

                if (result.reason !== "dismissed") {
                  toast({ title: "Unable to enable notifications right now.", variant: "error" })
                }
              }}
            >
              {loading ? "Enabling..." : "Enable notifications"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
