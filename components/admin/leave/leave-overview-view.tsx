import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ApplyLeaveOnBehalfDialog,
  type ApplyLeaveEmployeeOption,
} from "@/components/admin/leave/apply-leave-on-behalf-dialog"
import { LeaveAuditLog } from "@/components/admin/leave/leave-audit-log"
import type {
  LeaveAuditEntry,
  LeaveOverviewReport,
} from "@/modules/leave/application/services/leave-overview.service"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

export function LeaveOverviewView({
  report,
  auditRows,
  leaveTypes,
  employees,
  auditFrom,
  auditTo,
}: {
  report: LeaveOverviewReport
  auditRows: LeaveAuditEntry[]
  leaveTypes: Array<{ id: string; code: string; name: string }>
  /// Employee picker source for the apply-on-behalf dialog. Already
  /// scoped to the active admin's policy grants by the page.
  employees: ApplyLeaveEmployeeOption[]
  auditFrom: string
  auditTo: string
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Leave Overview</h1>
          <p className="text-sm text-muted-foreground">
            Snapshot of leave activity in {report.year}.
          </p>
        </div>
        <ApplyLeaveOnBehalfDialog
          employees={employees}
          leaveTypes={leaveTypes}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Pending" value={report.totals.pending} tone="warn" />
        <StatCard label="Approved" value={report.totals.approved} tone="ok" />
        <StatCard label="Rejected" value={report.totals.rejected} tone="err" />
        <StatCard label="Cancelled" value={report.totals.cancelled} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>On leave today</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {report.onLeaveToday.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No one is on leave today.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.onLeaveToday.map((a) => (
                  <TableRow key={`${a.employeeId}-${a.startDate}`}>
                    <TableCell className="font-medium">{a.employeeName}</TableCell>
                    <TableCell>{a.leaveTypeName}</TableCell>
                    <TableCell>
                      {fmtDate(a.startDate)}
                      {a.startDate !== a.endDate && <> → {fmtDate(a.endDate)}</>}
                      {a.duration !== "FULL_DAY" && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({a.duration === "MORNING" ? "AM" : "PM"})
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <LeaveAuditLog
        initialRows={auditRows}
        leaveTypes={leaveTypes}
        initialFrom={auditFrom}
        initialTo={auditTo}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "ok" | "warn" | "err" | "muted"
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "err"
          ? "text-destructive"
          : "text-muted-foreground"
  return (
    <Card className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className={`text-3xl font-black ${toneClass}`}>{value}</div>
    </Card>
  )
}
