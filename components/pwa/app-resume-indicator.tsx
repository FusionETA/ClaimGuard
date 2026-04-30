"use client"

import { useEffect, useRef, useState } from "react"

import { AppSplash } from "@/components/pwa/app-splash"

const BOOT_OVERLAY_MS = 650
const RESUME_OVERLAY_MS = 900
const RESUME_THRESHOLD_MS = 60_000

export function AppResumeIndicator({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = useState<string | null>("Opening ClaimGuard...")
  const timerRef = useRef<number | null>(null)
  const hiddenAtRef = useRef<number | null>(null)

  useEffect(() => {
    showOverlay("Opening ClaimGuard...", BOOT_OVERLAY_MS)

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now()
        return
      }

      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = null

      if (hiddenAt && Date.now() - hiddenAt >= RESUME_THRESHOLD_MS) {
        showOverlay("Resuming your workspace...", RESUME_OVERLAY_MS)
      }
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        showOverlay("Resuming your workspace...", RESUME_OVERLAY_MS)
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
