import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import {
  approvalStatusMeta,
  attendanceStatusMeta,
  otSubtypeMeta,
} from "@/modules/attendance/domain/metadata"
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

const APPROVAL_VARIANT: Record<string, string> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
}

function monthKey(iso: string, tz: string) {
  const d = new Date(iso)
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: tz })
}

function fmtTime(iso: string | null, tz: string) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      })
    : "—"
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
  const orgId = resolveActiveOrgId(session) ?? null
  const tz = await attendanceRepository.getOrgTimezone(orgId)
  const records = await employeeAttendanceService.getEmployeeHistory(
    session.userId,
    monthAgo,
    now,
  )
  const otRecords = await employeeAttendanceService.getEmployeeOTRecords(session.userId)
  const rejectedClockEvents = await employeeAttendanceService.getRejectedClockEvents(
    session.userId,
    monthAgo,
    now,
  )
  const rejectionsByDate = new Map<
    string,
    Array<{ kind: "CLOCK_IN" | "CLOCK_OUT"; reviewNotes: string | null; reviewerName: string | null }>
  >()
  for (const r of rejectedClockEvents) {
    if (!rejectionsByDate.has(r.date)) rejectionsByDate.set(r.date, [])
    rejectionsByDate.get(r.date)!.push({
      kind: r.kind,
      reviewNotes: r.reviewNotes,
      reviewerName: r.reviewerName,
    })
  }

  const byMonth = new Map<string, AttendanceRecordView[]>()
  for (const r of records) {
    const key = monthKey(r.date, tz)
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

      {months.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No attendance records in the last 30 days.
          </p>
        </Card>
      ) : (
        months.map((month) => {
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
                    {items.map((r) => {
                      const rejections = rejectionsByDate.get(r.date) ?? []
                      return (
                        <div
                          key={r.id}
                          className={cn(
                            "flex flex-col gap-2 rounded-xl border-l-4 px-4 py-3",
                            r.status === "ON_TIME"
                              ? "border-l-success"
                              : r.status === "LATE"
                                ? "border-l-tertiary"
                                : "border-l-destructive",
                          )}
                        >
                          <div className="flex items-center gap-3">
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
                                {fmtTime(r.timeIn, tz)}{" "}
                                {r.timeOut ? `– ${fmtTime(r.timeOut, tz)}` : ""}{" "}
                                {r.project ? `• ${r.project}` : r.location ? `• ${r.location}` : ""}
                              </p>
                            </div>
                            <Badge variant={STATUS_VARIANT[r.status] as never}>
                              {attendanceStatusMeta[r.status].label}
                            </Badge>
                          </div>
                          {rejections.map((rej, idx) => (
                            <div
                              key={`${r.id}-rej-${idx}`}
                              className="ml-8 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
                            >
                              <span className="font-semibold">
                                {rej.kind === "CLOCK_IN" ? "Clock-in rejected" : "Clock-out rejected"}
                              </span>
                              {rej.reviewerName ? ` by ${rej.reviewerName}` : ""}
                              {rej.reviewNotes ? ` — ${rej.reviewNotes}` : ""}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            </section>
          )
        })
      )}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="font-headline text-lg font-bold text-foreground">
            OT &amp; replacements
          </h3>
          <span className="text-xs text-muted-foreground">{otRecords.length} entries</span>
        </div>

        {otRecords.length === 0 ? (
          <Card className="p-4 text-center">
            <p className="text-sm text-muted-foreground">No overtime entries.</p>
          </Card>
        ) : (
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
                        {r.otSubtype ? otSubtypeMeta[r.otSubtype].label : "OT"} • {r.date}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                    </div>
                    <Badge variant={APPROVAL_VARIANT[r.status] as never}>
                      {approvalStatusMeta[r.status].label}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}
