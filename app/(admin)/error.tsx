"use client"

import { useEffect } from "react"

/**
 * Error boundary for the admin route group. Caught by Next when any
 * server component / action / page throws beneath `/admin`. The user
 * sees a calm fallback instead of the framework's default screen.
 *
 * We log to the console here so the browser devtools still surface the
 * stack — the server side is logged separately via lib/log.ts. In
 * production hook this into Sentry/Better Stack: replace the
 * console.error with `Sentry.captureException(error)`.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[admin] route error", error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-xl font-semibold">Something broke on this page.</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        The team has been notified. You can try reloading — if it keeps
        happening, please contact support and share the reference ID.
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
