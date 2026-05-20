import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { LeaveOverviewReport } from "@/modules/leave/application/services/leave-overview.service"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

function statusBadgeVariant(status: string): "pending" | "approved" | "rejected" | "outline" {
  if (status === "APPROVED") return "approved"
  if (status === "REJECTED") return "rejected"
  if (status === "PENDING") return "pending"
  return "outline"
}

export function LeaveOverviewView({ report }: { report: LeaveOverviewReport }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Leave Overview</h1>
        <p className="text-sm text-muted-foreground">
          Snapshot of leave activity in {report.year}.
        </p>
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

      <Card>
        <CardHeader>
          <CardTitle>Days used by type ({report.year})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {report.daysUsedByType.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No leave types configured yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Days used (approved)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.daysUsedByType.map((row) => (
                  <TableRow key={row.leaveTypeId}>
                    <TableCell className="font-mono text-xs font-bold">{row.code}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>
                      {row.daysUsed}
                      {!row.paid && (
                        <span className="ml-2 text-xs text-muted-foreground">(unpaid)</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent applications</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {report.recentApplications.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No applications yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.recentApplications.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.employeeName}</TableCell>
                    <TableCell className="font-mono text-xs">{a.leaveTypeCode}</TableCell>
                    <TableCell>
                      {fmtDate(a.startDate)}
                      {a.startDate !== a.endDate && <> → {fmtDate(a.endDate)}</>}
                    </TableCell>
                    <TableCell>{a.totalDays}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(a.status)}>{a.status}</Badge>
                    </TableCell>
                    <TableCell>{fmtDate(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
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
