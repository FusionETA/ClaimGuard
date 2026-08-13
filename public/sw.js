// Bumped to v2 to evict the v1 cache, which could hold a rendered "/" page
// snapshot (see handleNavigationRequest). The `activate` handler below deletes
// every cache whose key !== CACHE_NAME, so the poisoned entry is dropped on the
// next launch on every device.
const CACHE_NAME = "altomatehr-shell-v2"
const OFFLINE_FALLBACK = "/offline.html"
const BRAND_ICON_URL = "/brand-icon-white.png?v=4"
// Static, session-independent assets only. "/" is deliberately NOT precached —
// it renders the employee dashboard with the clock-in/out state baked in.
const APP_SHELL = [OFFLINE_FALLBACK, BRAND_ICON_URL]
// On iOS PWA cold-resume, fetch() can hang indefinitely without erroring.
// Cap navigation requests at this many ms before falling back to cache so the
// app never gets stuck on a black screen waiting for a half-suspended network.
const NAV_TIMEOUT_MS = 4000

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
    // API routes that stream file downloads (XLSX, PDF, TXT) come in
    // as `mode: "navigate"` when clicked via <a href>. Forcing them
    // through the app-shell navigation handler causes a 4s race vs a
    // multi-MB XLSX, often losing — the user ends up on the cached
    // "/" splash instead of getting the download. Let the network
    // handle these directly; the response's Content-Disposition
    // header makes the browser download without changing the page.
    if (url.pathname.startsWith("/api/")) {
      return
    }
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
  // Race the network against a hard timeout. iOS PWAs woken from a long idle
  // can have a half-suspended network where fetch() neither resolves nor
  // rejects — without this guard the user sees a black screen forever.
  //
  // Navigation responses are NEVER cached. A navigation response is a fully
  // rendered, session-specific page with today's attendance state baked into
  // the HTML, and the in-app updates after a clock-in go through an RSC
  // refresh (not a navigation) — so a cached copy freezes at whatever the
  // state was on the last full page load. That is exactly how an employee who
  // clocked in at 07:37 was still served a "Clock in" card at 22:09: the
  // stale snapshot won the 4s race on a weak signal. Wrong state on a clock
  // card is worse than an honest offline page, so the only fallback now is
  // the static offline page, which retries by itself.
  const networkPromise = getNavigationNetworkResponse(event).catch(() => null)

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve(null), NAV_TIMEOUT_MS),
  )

  const winner = await Promise.race([networkPromise, timeoutPromise])
  if (winner) {
    return winner
  }

  return (await caches.match(OFFLINE_FALLBACK)) || Response.error()
}

async function getNavigationNetworkResponse(event) {
  const preloadResponse = await event.preloadResponse
  if (preloadResponse) {
    return preloadResponse
  }

  return fetch(event.request)
}

self.addEventListener("push", (event) => {
  if (!event.data) {
    return
  }

  let payload = {
    title: "AltomateHR",
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
