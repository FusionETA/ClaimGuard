/**
 * Download buttons for the per-employee Leave & Attendance report PDFs.
 *
 * The routes authorise by role (`resolveEmployeeReportAccess`) — admin = any
 * employee in the org, supervisor = their team, employee = themselves — so the
 * same component drops onto the admin, supervisor, and employee detail pages.
 *
 * Plain download anchors (no target="_blank") so the browser saves straight
 * from the server's `Content-Disposition: attachment` header instead of
 * briefly opening then auto-closing a tab. An empty `download` lets the
 * server-supplied filename win.
 */
export function ReportExportButtons({
  employeeId,
  from,
  to,
  year,
}: {
  /** User id of the employee whose report to download. */
  employeeId: string
  /** Attendance range start, ISO yyyy-mm-dd. */
  from: string
  /** Attendance range end, ISO yyyy-mm-dd. */
  to: string
  /** Leave summary year. */
  year: number
}) {
  const cls =
    "inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={`/api/attendance/export/report?employeeId=${employeeId}&from=${from}&to=${to}`}
        download=""
        rel="noopener"
        className={cls}
      >
        Export Attendance PDF
      </a>
      <a
        href={`/api/leave/export/summary?employeeId=${employeeId}&year=${year}`}
        download=""
        rel="noopener"
        className={cls}
      >
        Export Leave PDF
      </a>
    </div>
  )
}
