"use client"

import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"

/**
 * Error boundary for the employee route group. Mirrors the admin
 * boundary — keeps a broken screen from leaking the framework error
 * page to end users, captures the exception to Sentry.
 */
export default function EmployeeError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { route_group: "employee", digest: error.digest },
    })
    console.error("[employee] route error", error)
  }, [error])

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
