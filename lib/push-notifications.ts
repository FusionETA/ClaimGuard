export function pushNotificationsSupported() {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  )
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const normalized = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = window.atob(normalized)
  const outputArray = new Uint8Array(rawData.length)

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index)
  }

  return outputArray
}

export async function registerPushServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return null
  }

  return navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  })
}

async function fetchVapidKey() {
  const response = await fetch("/api/push/subscribe", {
    method: "GET",
    credentials: "include",
  })

  if (!response.ok) {
    return null
  }

  const data = (await response.json()) as { publicKey?: string }
  return data.publicKey ?? null
}

export async function hasPushSubscription(registration?: ServiceWorkerRegistration | null) {
  if (!pushNotificationsSupported()) {
    return false
  }

  const serviceWorkerRegistration = registration ?? (await navigator.serviceWorker.getRegistration())

  if (!serviceWorkerRegistration) {
    return false
  }

  const subscription = await serviceWorkerRegistration.pushManager.getSubscription()
  return Boolean(subscription)
}

export async function syncPushSubscription(registration?: ServiceWorkerRegistration | null) {
  if (!pushNotificationsSupported() || Notification.permission !== "granted") {
    return { ok: false as const, reason: "not-granted" }
  }

  const serviceWorkerRegistration = registration ?? (await registerPushServiceWorker())

  if (!serviceWorkerRegistration) {
    return { ok: false as const, reason: "sw-unavailable" }
  }

  const publicKey = await fetchVapidKey()

  if (!publicKey) {
    return { ok: false as const, reason: "missing-vapid" }
  }

  let subscription = await serviceWorkerRegistration.pushManager.getSubscription()

  if (!subscription) {
    subscription = await serviceWorkerRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }

  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subscription.toJSON()),
  }).catch(() => null)

  if (!response?.ok) {
    return { ok: false as const, reason: "subscribe-failed" }
  }

  return { ok: true as const }
}

export async function subscribeToPushNotifications() {
  if (!pushNotificationsSupported()) {
    return { ok: false as const, reason: "unsupported" }
  }

  let permission: NotificationPermission = Notification.permission

  if (permission === "default") {
    permission = await Notification.requestPermission()
  }

  if (permission !== "granted") {
    return { ok: false as const, reason: permission === "denied" ? "denied" : "dismissed" }
  }

  return syncPushSubscription()
}
