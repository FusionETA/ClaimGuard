import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import type {
  ClockEventLite,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

import { TodayAdjustmentCard } from "./today-adjustment-card"
import { ElapsedTimer } from "./elapsed-timer"

// The clock-in card lives on the dashboard (`/employee`) so the
// landing page is the single entry point for the fingerprint action.
// This attendance tab is history + today's remark + recent shifts;
// no clock-in surface here — kills the duplicate UI users saw when
// both routes rendered the same <ClockCard />.

type Props = {
  dashboard: EmployeeAttendanceDashboard
  workingHours: { start: string; end: string }
  timezone: string
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

function deriveState(events: ClockEventLite[]): "IN" | "OUT" {
  const last = [...events]
    .reverse()
    .find(
      (e) =>
        (e.kind === "CLOCK_IN" || e.kind === "CLOCK_OUT") &&
        e.status !== "REJECTED",
    )
  return last?.kind === "CLOCK_IN" ? "IN" : "OUT"
}

export function EmployeeAttendanceDashboardView({
  dashboard,
  workingHours,
  timezone,
}: Props) {
  const state = deriveState(dashboard.todayEvents)
  // How many shifts today (each clock-in/out pair is a session).
  const shiftCount = dashboard.today?.sessions.length ?? 0

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Working hours
            </p>
            <p className="mt-0.5 font-headline text-lg font-extrabold text-foreground">
              {workingHours.start} – {workingHours.end}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge variant={state === "IN" ? "clocked-in" : "clocked-out"}>
              {state === "IN" ? "On the clock" : "Not started"}
            </Badge>
            {shiftCount > 0 ? (
              <span className="text-[10px] font-semibold text-muted-foreground">
                {state === "IN"
                  ? `Shift ${shiftCount} today`
                  : `${shiftCount} shift${shiftCount > 1 ? "s" : ""} today`}
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      {dashboard.today ? (
        <TodayAdjustmentCard
          recordId={dashboard.today.id}
          currentTimeInUtc={dashboard.today.timeIn}
          currentTimeOutUtc={dashboard.today.timeOut}
          offSiteNotes={dashboard.today.notes}
        />
      ) : null}

      {dashboard.todayEvents.length > 0 ? (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-sm font-bold text-foreground">Today&apos;s events</p>
            <div className="space-y-2">
              {dashboard.todayEvents.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 border-b border-border/50 py-2 last:border-0"
                >
                  <Badge
                    variant={
                      e.kind === "CLOCK_IN"
                        ? "clocked-in"
                        : e.kind === "CLOCK_OUT"
                          ? "clocked-out"
                          : "pending"
                    }
                  >
                    {e.kind === "CLOCK_IN"
                      ? "Clock in"
                      : e.kind === "CLOCK_OUT"
                        ? "Clock out"
                        : e.breakSubtype === "end"
                          ? "Break end"
                          : e.breakSubtype === "start"
                            ? "Break start"
                            : "Break"}
                  </Badge>
                  <span className="text-sm font-semibold text-foreground">
                    {fmtTime(e.eventAt, timezone)}
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {e.status === "PENDING"
                      ? "Pending approval"
                      : e.status === "APPROVED"
                        ? "Approved"
                        : "Rejected"}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div>
        <p className="mb-2 text-sm font-bold text-foreground">Recent shifts</p>
        {dashboard.weekToDate.length === 0 ? (
          <Card className="p-4 text-center">
            <p className="text-sm text-muted-foreground">
              No attendance records yet this week.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {dashboard.weekToDate.slice(0, 5).map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 shadow-panel"
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
                  <p className="truncate text-sm font-semibold text-foreground">{r.date}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtTime(r.timeIn, timezone)}{" "}
                    {r.timeOut
                      ? `– ${fmtTime(r.timeOut, timezone)}`
                      : r.timeIn
                        ? "– "
                        : ""}{" "}
                    {r.project ? `• ${r.project}` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-bold text-muted-foreground">
                  {r.durationMin != null
                    ? `${Math.floor(r.durationMin / 60)}h ${r.durationMin % 60}m`
                    : r.timeIn != null
                      ? <ElapsedTimer startedAt={r.timeIn} />
                      : "–"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
