import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { attendanceStatusMeta, otStatusMeta, otTypeMeta } from "@/modules/attendance/domain/metadata"
import type { AttendanceRecordView } from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

const STATUS_VARIANT: Record<string, string> = {
  ON_TIME: "on-time",
  LATE: "late",
  MISSING: "missing",
  ON_LEAVE: "on-leave",
  CLOCKED_IN: "clocked-in",
  CLOCKED_OUT: "clocked-out",
}

const OT_VARIANT: Record<string, string> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  OFFSET: "offset",
  UNRESOLVED: "unresolved",
}

// Best-effort month extraction from the mock string ("Mon, Oct 23" → "Oct")
function monthOf(dateStr: string) {
  const parts = dateStr.split(",")
  const tail = (parts[1] ?? parts[0]).trim().split(" ")
  return tail[0] ?? "Unknown"
}

function summarise(records: AttendanceRecordView[]) {
  const totalMin = records.reduce((acc, r) => acc + (r.durationMin ?? 0), 0)
  return {
    totalHours: Math.floor(totalMin / 60),
    totalRemainder: totalMin % 60,
    onTime: records.filter((r) => r.status === "ON_TIME").length,
    late: records.filter((r) => r.status === "LATE").length,
    missing: records.filter((r) => r.status === "MISSING").length,
  }
}

export default async function EmployeeHistoryPage() {
  const session = await requirePortalSession("EMPLOYEE")
  const now = new Date()
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const records = await employeeAttendanceService.getEmployeeHistory(
    session.userId,
    monthAgo,
    now,
  )
  const otRecords = await employeeAttendanceService.getEmployeeOTRecords(session.userId)

  // Group attendance records by month label (mock-friendly).
  const byMonth = new Map<string, AttendanceRecordView[]>()
  for (const r of records) {
    const key = monthOf(r.date)
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key)!.push(r)
  }
  const months = Array.from(byMonth.keys())

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Last 30 days
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-foreground">Attendance history</h2>
      </div>

      {months.map((month) => {
        const items = byMonth.get(month)!
        const sum = summarise(items)
        return (
          <section key={month} className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="font-headline text-lg font-bold text-foreground">{month}</h3>
              <span className="text-xs text-muted-foreground">{items.length} days</span>
            </div>

            <Card className="bg-secondary/40 p-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div>
                  <p className="font-headline text-2xl font-extrabold text-foreground">
                    {sum.totalHours}h{" "}
                    <span className="text-base">{sum.totalRemainder}m</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">Total worked</p>
                </div>
                <div>
                  <p className="font-headline text-2xl font-extrabold text-success">
                    {sum.onTime}
                  </p>
                  <p className="text-[11px] text-muted-foreground">On time</p>
                </div>
                <div>
                  <p className="font-headline text-2xl font-extrabold text-tertiary">
                    {sum.late}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Late</p>
                </div>
                <div>
                  <p className="font-headline text-2xl font-extrabold text-destructive">
                    {sum.missing}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Missing</p>
                </div>
              </div>
            </Card>

            <Card>
              <CardContent className="p-2">
                <div className="space-y-1">
                  {items.map((r) => (
                    <div
                      key={r.id}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border-l-4 px-4 py-3",
                        r.status === "ON_TIME"
                          ? "border-l-success"
                          : r.status === "LATE"
                            ? "border-l-tertiary"
                            : "border-l-destructive",
                      )}
                    >
                      {r.status === "MISSING" ? (
                        <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                      ) : (
                        <CheckCircle2
                          className={cn(
                            "h-5 w-5 shrink-0",
                            r.status === "ON_TIME" ? "text-success" : "text-tertiary",
                          )}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {r.date}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {r.timeIn} {r.timeOut ? `– ${r.timeOut}` : ""} • {r.location}
                        </p>
                      </div>
                      <Badge variant={STATUS_VARIANT[r.status] as never}>
                        {attendanceStatusMeta[r.status].label}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </section>
        )
      })}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="font-headline text-lg font-bold text-foreground">
            OT &amp; replacements
          </h3>
          <span className="text-xs text-muted-foreground">{otRecords.length} entries</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Accumulated", value: "14h 42m" },
            { label: "Approved", value: "12.5h" },
            { label: "Pending", value: "2.2h" },
          ].map((s) => (
            <Card key={s.label} className="p-3 text-center">
              <p className="font-headline text-lg font-extrabold text-foreground">
                {s.value}
              </p>
              <p className="text-[10px] font-semibold text-muted-foreground">{s.label}</p>
            </Card>
          ))}
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-3">
              {otRecords.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start gap-3 border-b border-border/50 pb-3 last:border-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-foreground">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {otTypeMeta[r.type].label} • {r.date}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                  </div>
                  <Badge variant={OT_VARIANT[r.status] as never}>
                    {otStatusMeta[r.status].label}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
