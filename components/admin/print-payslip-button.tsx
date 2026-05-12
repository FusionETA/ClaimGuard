"use client"

import { Printer } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Small client-side "Print / Save as PDF" trigger. Calls
 * `window.print()` — every modern browser's print dialog can save to
 * PDF, so we don't need a server-side PDF library for v1.
 *
 * Pair with `print:hidden` on chrome (back buttons, nav, action bars)
 * and the inline `@media print` rules on the payslip detail page so
 * the printed output is clean.
 */
export function PrintPayslipButton({
  label = "Print / Save as PDF",
}: {
  label?: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => window.print()}
      className="gap-2"
    >
      <Printer className="h-4 w-4" />
      {label}
    </Button>
  )
}
