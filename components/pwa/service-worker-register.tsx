"use client"

import { useEffect } from "react"

import {
  registerPushServiceWorker,
  syncPushSubscription,
} from "@/lib/push-notifications"

export function ServiceWorkerRegister() {
  useEffect(() => {
    const pathname = window.location.pathname
    const shouldManagePush = pathname.startsWith("/employee")

    void registerPushServiceWorker()
      .then(async (registration) => {
        if (!registration || !shouldManagePush || Notification.permission !== "granted") {
          return
        }

        await syncPushSubscription(registration).catch(() => null)
      })
      .catch((error) => {
        console.error("Service worker registration failed", error)
      })
  }, [])

  return null
}
