const CACHE_NAME = "claimguard-shell-v7"
const OFFLINE_FALLBACK = "/offline.html"
const LAUNCH_FALLBACK = "/launch.html"
const BRAND_ICON_URL = "/brand-icon-white.png?v=3"
const NAVIGATION_TIMEOUT_MS = 1200
const APP_SHELL = ["/", OFFLINE_FALLBACK, LAUNCH_FALLBACK, BRAND_ICON_URL]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if ("navigationPreload" in self.registration) {
        await self.registration.navigationPreload.enable().catch(() => undefined)
      }

      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return
  }

  const url = new URL(event.request.url)

  if (event.request.mode === "navigate") {
    event.respondWith(handleNavigationRequest(event))
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

async function handleNavigationRequest(event) {
  try {
    const response = await Promise.race([
      getNavigationNetworkResponse(event),
      wait(NAVIGATION_TIMEOUT_MS),
    ])

    if (response) {
      return response
    }

    return (
      (await caches.match(LAUNCH_FALLBACK)) ||
      (await caches.match(OFFLINE_FALLBACK)) ||
      Response.error()
    )
  } catch {
    return (await caches.match(OFFLINE_FALLBACK)) || Response.error()
  }
}

async function getNavigationNetworkResponse(event) {
  const preloadResponse = await event.preloadResponse
  if (preloadResponse) {
    return preloadResponse
  }

  return fetch(event.request)
}

function wait(durationMs) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), durationMs)
  })
}

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
      icon: BRAND_ICON_URL,
      badge: BRAND_ICON_URL,
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
