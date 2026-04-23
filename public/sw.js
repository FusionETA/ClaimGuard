const CACHE_NAME = "claimguard-shell-v4"
const OFFLINE_FALLBACK = "/offline.html"
const APP_SHELL = ["/", OFFLINE_FALLBACK, "/brand-logo.png"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return
  }

  const url = new URL(event.request.url)

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_FALLBACK)))
    return
  }

  // Never cache Next.js build assets or non-app-origin requests.
  // Serving stale JS/CSS can leave the UI rendered but unresponsive after deploys.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/_next/")) {
    return
  }

  if (!APP_SHELL.includes(url.pathname)) {
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached
      }

      return fetch(event.request).then((response) => {
        const cloned = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned))
        return response
      })
    })
  )
})

self.addEventListener("push", (event) => {
  if (!event.data) {
    return
  }

  let payload = {
    title: "ClaimGuard",
    body: "",
    url: "/",
  }

  try {
    payload = {
      ...payload,
      ...event.data.json(),
    }
  } catch {
    payload.body = event.data.text()
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      data: {
        url: payload.url || "/",
      },
      icon: "/brand-logo.png",
      badge: "/brand-logo.png",
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).toString()

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client && client.url.startsWith(self.location.origin)) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }

      return self.clients.openWindow(targetUrl)
    })
  )
})
