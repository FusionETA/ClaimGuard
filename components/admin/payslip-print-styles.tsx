/**
 * Drop-in style block + document title override for the payslip print
 * view. Server component (no `"use client"` needed) — just emits a
 * <style> tag scoped to the page.
 *
 * Tailwind's `print:` variants handle most layout switches; this file
 * picks up what Tailwind can't easily express: page size, page
 * margins, and a few rules that have to fire on `body` / `html`
 * directly.
 */
export function PayslipPrintStyles({ title }: { title?: string }) {
  return (
    <>
      {title ? <title>{title}</title> : null}
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 14mm 12mm 14mm 12mm;
          }
          html, body {
            background: #fff !important;
            color: #000 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          /* Make sure cards print cleanly without page-break in the
             middle of a row. */
          .print-payslip-card,
          [data-payslip-card] {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          /* Hide app shell chrome (sidebars, headers, footers) when
             printing. Each shell layer also opts itself out via
             print:hidden, but this is a belt-and-braces fallback. */
          header[data-app-shell-header],
          aside[data-app-shell-sidebar],
          nav[data-app-shell-nav],
          [data-app-shell="header"],
          [data-app-shell="sidebar"],
          [data-app-shell="footer"] {
            display: none !important;
          }
          /* Make sure shadcn cards use a thin grayscale border + no
             shadow so the print isn't muddy. */
          .rounded-lg, .rounded-xl, .rounded-md {
            box-shadow: none !important;
          }
          /* Prevent strange double-bg on muted utility classes. */
          .bg-muted\\/30, .bg-muted\\/50, .bg-card {
            background: transparent !important;
          }
        }
      `}</style>
    </>
  )
}
