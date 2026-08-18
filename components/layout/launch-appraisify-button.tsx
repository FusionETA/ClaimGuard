import { ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * "Launch Appraisify" — sends the browser to GET /api/sso/appraisify,
 * which mints a one-time SSO ticket for the current session and
 * redirects into AppraisifyAlt, already signed in.
 *
 * Deliberately a plain `<a>` (via Button's `asChild`), NOT `next/link` —
 * Next's Link prefetch would silently hit the minter ahead of a real
 * click and burn a one-time ticket before the user ever navigates.
 */
export function LaunchAppraisifyButton() {
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      title="Launch Appraisify"
      className="shrink-0 rounded-full"
    >
      <a href="/api/sso/appraisify" aria-label="Launch Appraisify">
        <ExternalLink className="h-4 w-4" />
        <span className="hidden sm:inline">Appraisify</span>
      </a>
    </Button>
  )
}
