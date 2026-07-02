"use client"

import { FileDown, Loader2 } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toaster"

/**
 * Client-side download button for the payroll summary PDF.
 *
 * Why not a plain `<a href="/summary?download=1">`?
 *   A bare anchor causes the browser to NAVIGATE to the summary URL.
 *   Even though the response sends `Content-Disposition: attachment`
 *   which triggers a download, some browsers (esp. mobile Safari and
 *   in-app webviews) leave the tab sitting on that raw route URL with
 *   no visible UI — Nicholas reported it as "logs me out". The user
 *   then hits back / refresh and lands somewhere unexpected.
 *
 * Instead: fetch the URL from the current page, convert to a blob,
 * synthesize an anchor with a download attribute, click it, revoke
 * the blob URL. The current page never navigates; any error is
 * surfaced as a toast so the user can retry.
 */
export function DownloadPayrollSummaryButton({
  runId,
  filenameHint,
  className,
}: {
  runId: string
  /// Optional filename shown in the browser's Save dialog when the
  /// Content-Disposition header is absent from the fetch response.
  /// The route DOES send it, so this is only a fallback.
  filenameHint?: string
  className?: string
}) {
  const [pending, setPending] = useState(false)
  const { toast } = useToast()

  async function handleClick() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch(
        `/admin/payroll/runs/${encodeURIComponent(runId)}/summary?download=1`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/pdf" },
        },
      )
      if (!response.ok) {
        // 404 = "not found", 409 = "run payroll before downloading",
        // 401/403 = session lapsed. Surface whatever the server said.
        let message = "Couldn't download the summary PDF."
        try {
          const body = await response.json()
          if (typeof body?.error === "string") message = body.error
        } catch {
          // Body isn't JSON — keep the generic message.
        }
        toast({ title: message, variant: "error" })
        return
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)

      // Prefer the filename the server sent via Content-Disposition;
      // fall back to the hint (or a plain default) so the browser
      // still saves something sensible.
      const disposition = response.headers.get("Content-Disposition") ?? ""
      const filename =
        parseAttachmentFilename(disposition) ??
        filenameHint ??
        "payroll-summary.pdf"

      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Delay revoke slightly — some browsers (Safari) need a tick
      // before the download commits.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      toast({
        title:
          err instanceof Error
            ? err.message
            : "Couldn't download the summary PDF.",
        variant: "error",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={handleClick}
      disabled={pending}
      title="Download a PDF summary to send to an off-system approver"
    >
      {pending ? (
        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
      ) : (
        <FileDown className="mr-1.5 h-4 w-4" />
      )}
      {pending ? "Preparing…" : "Download summary PDF"}
    </Button>
  )
}

/**
 * Extract the `filename` (RFC 5987 `filename*` preferred) from a
 * Content-Disposition header. Returns null if none is set.
 */
function parseAttachmentFilename(disposition: string): string | null {
  // RFC 5987 encoded — `filename*=UTF-8''My%20Name.pdf`
  const encoded = /filename\*=(?:UTF-8''|)([^;]+)/i.exec(disposition)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""))
    } catch {
      // Fall through to the plain filename below.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain?.[1]?.trim() ?? null
}
