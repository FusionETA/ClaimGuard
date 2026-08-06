import Link from "next/link"
import type { Route } from "next"
import { ChevronLeft } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Canonical page-level "Back" control — a ghost pill with a left chevron,
 * matching the back button on the payslip / payroll-run detail pages.
 *
 * Use this for back-to-parent navigation everywhere instead of an ad-hoc
 * text link, so every back affordance looks and behaves the same (and no
 * more long "← Back to X" links with an underline-on-hover).
 */
export function BackButton({
  href,
  label = "Back",
  className,
}: {
  href: Route
  /** Defaults to "Back". Only pass a longer label where the destination is
   *  genuinely ambiguous (a page reachable from several parents). */
  label?: string
  className?: string
}) {
  return (
    <Button asChild variant="ghost" size="sm" className={className}>
      <Link href={href}>
        <ChevronLeft className="h-4 w-4" />
        {label}
      </Link>
    </Button>
  )
}
