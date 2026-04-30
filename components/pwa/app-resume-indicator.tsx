"use client"

import { useEffect, useRef, useState } from "react"

import { AppSplash } from "@/components/pwa/app-splash"

const BOOT_OVERLAY_MS = 650
const RESUME_OVERLAY_MS = 900
const RESUME_THRESHOLD_MS = 60_000
const RECOVERY_RELOAD_GUARD_MS = 15_000
const RECOVERY_RELOAD_KEY = "claimguard:last-recovery-reload-at"

export function AppResumeIndicator({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = useState<string | null>("Opening ClaimGuard...")
  const timerRef = useRef<number | null>(null)
  const hiddenAtRef = useRef<number | null>(null)

  useEffect(() => {
    // Strip the launch-splash escape marker from the URL so it doesn't linger in
    // history / share links. The marker tells the service worker to skip the
    // launch.html fallback for one navigation; it has no use after boot.
    try {
      const currentUrl = new URL(window.location.href)
      if (currentUrl.searchParams.has("__cgresume")) {
        currentUrl.searchParams.delete("__cgresume")
        const cleaned = currentUrl.pathname + (currentUrl.search ? currentUrl.search : "") + currentUrl.hash
        window.history.replaceState(window.history.state, "", cleaned)
      }
    } catch {
      // Non-fatal — marker just stays in the URL.
    }

    showOverlay("Opening ClaimGuard...", BOOT_OVERLAY_MS)

    function shouldSkipRecoveryReload() {
      try {
        const lastReloadAt = Number(window.sessionStorage.getItem(RECOVERY_RELOAD_KEY) ?? "0")
        return Number.isFinite(lastReloadAt) && Date.now() - lastReloadAt < RECOVERY_RELOAD_GUARD_MS
      } catch {
        return false
      }
    }

    function triggerRecoveryReload(nextLabel: string) {
      if (shouldSkipRecoveryReload()) {
        showOverlay(nextLabel, RESUME_OVERLAY_MS)
        return
      }

      try {
        window.sessionStorage.setItem(RECOVERY_RELOAD_KEY, String(Date.now()))
      } catch {
        // Ignore storage failures — reload is still safe.
      }

      showOverlay(nextLabel, 4_000)
      window.setTimeout(() => {
        window.location.reload()
      }, 120)
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now()
        return
      }

      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = null

      if (hiddenAt && Date.now() - hiddenAt >= RESUME_THRESHOLD_MS) {
        triggerRecoveryReload("Refreshing your workspace...")
      }
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        triggerRecoveryReload("Refreshing your workspace...")
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("pageshow", handlePageShow)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("pageshow", handlePageShow)
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  function showOverlay(nextLabel: string, durationMs: number) {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }

    setLabel(nextLabel)
    timerRef.current = window.setTimeout(() => {
      setLabel(null)
      timerRef.current = null
    }, durationMs)
  }

  return (
    <>
      <div aria-hidden={Boolean(label)} className={label ? "invisible" : "visible"}>
        {children}
      </div>
      {label ? (
        <div className="fixed inset-0 z-[100]">
          <AppSplash label={label} />
        </div>
      ) : null}
    </>
  )
}
