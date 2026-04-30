"use client"

import { useEffect, useRef, useState } from "react"

import { AppSplash } from "@/components/pwa/app-splash"

const BOOT_OVERLAY_MS = 300
const RESUME_OVERLAY_MS = 600
// 5 minutes — switching apps briefly or locking the screen should never force a reload.
const RESUME_THRESHOLD_MS = 300_000
const RECOVERY_RELOAD_GUARD_MS = 15_000
const RECOVERY_RELOAD_KEY = "claimguard:last-recovery-reload-at"
// Single label used everywhere — no need for three different messages.
const SPLASH_LABEL = "Opening ClaimGuard..."

export function AppResumeIndicator({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(true)
  const timerRef = useRef<number | null>(null)
  const hiddenAtRef = useRef<number | null>(null)

  useEffect(() => {
    showOverlay(BOOT_OVERLAY_MS)

    function shouldSkipRecoveryReload() {
      try {
        const lastReloadAt = Number(window.sessionStorage.getItem(RECOVERY_RELOAD_KEY) ?? "0")
        return Number.isFinite(lastReloadAt) && Date.now() - lastReloadAt < RECOVERY_RELOAD_GUARD_MS
      } catch {
        return false
      }
    }

    function triggerRecoveryReload() {
      if (shouldSkipRecoveryReload()) {
        showOverlay(RESUME_OVERLAY_MS)
        return
      }

      try {
        window.sessionStorage.setItem(RECOVERY_RELOAD_KEY, String(Date.now()))
      } catch {
        // Ignore storage failures — reload is still safe.
      }

      showOverlay(3_000)
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

      // Only force a reload if the app was genuinely idle for a long time.
      if (hiddenAt && Date.now() - hiddenAt >= RESUME_THRESHOLD_MS) {
        triggerRecoveryReload()
      }
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted) return

      // bfcache restore — only reload if the app was hidden for long enough.
      // Without this guard every app-switch on iOS triggered a full reload.
      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = null

      if (hiddenAt && Date.now() - hiddenAt >= RESUME_THRESHOLD_MS) {
        triggerRecoveryReload()
      }
      // Otherwise bfcache restore is instant — let it stand as-is.
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

  function showOverlay(durationMs: number) {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }

    setVisible(true)
    timerRef.current = window.setTimeout(() => {
      setVisible(false)
      timerRef.current = null
    }, durationMs)
  }

  return (
    <>
      <div aria-hidden={visible} className={visible ? "invisible" : "visible"}>
        {children}
      </div>
      {visible ? (
        <div className="fixed inset-0 z-[100]">
          <AppSplash label={SPLASH_LABEL} />
        </div>
      ) : null}
    </>
  )
}
