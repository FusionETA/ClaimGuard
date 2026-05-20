import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { LeaveOverviewReport } from "@/modules/leave/application/services/leave-overview.service"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
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
        <CardContent>
          {report.onLeaveToday.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one is on leave today.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">Employee</th>
                    <th>Type</th>
                    <th>Dates</th>
                  </tr>
                </thead>
                <tbody>
                  {report.onLeaveToday.map((a) => (
                    <tr key={`${a.employeeId}-${a.startDate}`}>
                      <td className="py-2">{a.employeeName}</td>
                      <td>{a.leaveTypeName}</td>
                      <td>
                        {fmtDate(a.startDate)}
                        {a.startDate !== a.endDate && <> → {fmtDate(a.endDate)}</>}
                        {a.duration !== "FULL_DAY" && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({a.duration === "MORNING" ? "AM" : "PM"})
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Days used by type ({report.year})</CardTitle>
        </CardHeader>
        <CardContent>
          {report.daysUsedByType.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leave types configured yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">Code</th>
                    <th>Name</th>
                    <th>Days used (approved)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.daysUsedByType.map((row) => (
                    <tr key={row.leaveTypeId}>
                      <td className="py-2 font-mono">{row.code}</td>
                      <td>{row.name}</td>
                      <td>{row.daysUsed}{!row.paid && <span className="text-xs text-muted-foreground"> (unpaid)</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent applications</CardTitle>
        </CardHeader>
        <CardContent>
          {report.recentApplications.length === 0 ? (
            <p className="text-sm text-muted-foreground">No applications yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">Employee</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Days</th>
                    <th>Status</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recentApplications.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2">{a.employeeName}</td>
                      <td className="font-mono">{a.leaveTypeCode}</td>
                      <td>
                        {fmtDate(a.startDate)}
                        {a.startDate !== a.endDate && <> → {fmtDate(a.endDate)}</>}
                      </td>
                      <td>{a.totalDays}</td>
                      <td>
                        <span className={statusTone(a.status)}>{a.status}</span>
                      </td>
                      <td>{fmtDate(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
    <div className="rounded-2xl border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}

function statusTone(status: string): string {
  if (status === "APPROVED") return "text-emerald-600"
  if (status === "REJECTED") return "text-destructive"
  if (status === "CANCELLED") return "text-muted-foreground"
  return ""
}
