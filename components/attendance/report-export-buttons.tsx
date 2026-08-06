/**
 * Download buttons for the Leave & Attendance report PDFs.
 *
 * With `employeeId` set → a single employee's report, via the per-employee
 * routes gated by `resolveEmployeeReportAccess` (admin = anyone in the org,
 * supervisor = their team, employee = themselves). Used on the employee's own
 * page.
 *
 * Without `employeeId` → a WHOLE-TEAM report, via the team-bulk routes gated
 * by `resolveTeamReportAccess` (supervisor = their team in one PDF, admin =
 * whole org). Used on the supervisor Team tab.
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
  /** User id for a single-employee report. Omit for a whole-team report. */
  employeeId?: string
  /** Attendance range start, ISO yyyy-mm-dd. */
  from: string
  /** Attendance range end, ISO yyyy-mm-dd. */
  to: string
  /** Leave summary year. */
  year: number
}) {
  const cls =
    "inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
  const attendanceHref = employeeId
    ? `/api/attendance/export/report?employeeId=${employeeId}&from=${from}&to=${to}`
    : `/api/attendance/export/team-report?from=${from}&to=${to}`
  const leaveHref = employeeId
    ? `/api/leave/export/summary?employeeId=${employeeId}&year=${year}`
    : `/api/leave/export/team-summary?year=${year}`
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={attendanceHref} download="" rel="noopener" className={cls}>
        {employeeId ? "Export Attendance PDF" : "Export Team Attendance PDF"}
      </a>
      <a href={leaveHref} download="" rel="noopener" className={cls}>
        {employeeId ? "Export Leave PDF" : "Export Team Leave PDF"}
      </a>
    </div>
  )
}
