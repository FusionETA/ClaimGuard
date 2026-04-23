"use client"

import { useEffect } from "react"

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const normalized = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = window.atob(normalized)
  const outputArray = new Uint8Array(rawData.length)

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i)
  }

  return outputArray
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return
    }

    const pathname = window.location.pathname
    const shouldManagePush = pathname.startsWith("/employee")

    void navigator.serviceWorker
      .register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      })
      .then(async (registration) => {
        if (
          !shouldManagePush ||
          !("PushManager" in window) ||
          !("Notification" in window)
        ) {
          return
        }

        if (Notification.permission === "denied") {
          return
        }

        const keyResponse = await fetch("/api/push/subscribe", {
          method: "GET",
          credentials: "include",
        }).catch(() => null)

        if (!keyResponse?.ok) {
          return
        }

        const { publicKey } = (await keyResponse.json()) as { publicKey?: string }

        if (!publicKey) {
          return
        }

        let permission: NotificationPermission = Notification.permission

        if (permission === "default") {
          permission = await Notification.requestPermission()
        }

        if (permission !== "granted") {
          return
        }

        let subscription = await registration.pushManager.getSubscription()

        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          })
        }

        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(subscription.toJSON()),
        }).catch(() => null)
      })
      .catch((error) => {
        console.error("Service worker registration failed", error)
      })
  }, [])

  return null
}
