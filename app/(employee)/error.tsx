"use client"

import { useEffect, useState } from "react"

import { recoverFromStaleBuild } from "@/lib/stale-build-recovery"

/**
 * Error boundary for the employee route group. Mirrors the admin
 * boundary — keeps a broken screen from leaking the framework error
 * page to end users. Logs to devtools; the critical-notifier
 * (WhatsApp via Wazzup24) is Level-2 scoped to server-side errors, so
 * client-only crashes here don't page on-call.
 */
export default function EmployeeError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // Set by the effect below when the error turns out to be post-deploy version
  // skew and a reload is already on its way.
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    console.error("[employee] route error", error)
    if (recoverFromStaleBuild(error)) setRecovering(true)
  }, [error])

  if (recovering) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-xl font-semibold">Updating to the latest version…</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          This page is reloading. It only takes a moment.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-xl font-semibold">Something went wrong.</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Please try again. If the problem continues, contact your admin
        and share the reference ID.
      </p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Reference: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-md border px-4 py-2 text-sm hover:bg-muted"
      >
        Try again
      </button>
    </div>
  )
}
