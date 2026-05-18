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

/**
 * Release the device's push subscription on logout.
 *
 * Order matters:
 *   1. Tell the server to drop the DB row (while the session cookie is
 *      still valid — calling /api/push/unsubscribe AFTER the cookie is
 *      cleared would 401).
 *   2. Then ask the browser/OS to unsubscribe the pushManager, which
 *      tears down the channel with the platform push service (APNs /
 *      FCM). Without this, the OS keeps the channel alive and a later
 *      login on the same device gets back the same endpoint — fine,
 *      but means the user is never re-prompted for notification
 *      permission even if they expected to be.
 *
 * Both steps are best-effort: any failure is swallowed because
 * `logoutAction` ALSO wipes the row server-side as a fallback, so the
 * worst case is the OS-level channel hangs around with no rows
 * pointing at it (harmless — nothing to push).
 */
export async function unsubscribeFromPushNotifications(): Promise<void> {
  if (!pushNotificationsSupported()) return

  const registration = await navigator.serviceWorker
    .getRegistration()
    .catch(() => null)
  if (!registration) return

  const subscription = await registration.pushManager
    .getSubscription()
    .catch(() => null)
  if (!subscription) return

  // Step 1 — server-side row cleanup (best effort, session still valid)
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => null)

  // Step 2 — OS-level pushManager unsubscribe (best effort)
  await subscription.unsubscribe().catch(() => null)
}
