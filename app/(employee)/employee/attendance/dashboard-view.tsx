import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import type {
  AttendanceProjectView,
  ClockEventLite,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

import { ClockCard } from "./clock-card"

type Props = {
  firstName: string
  dashboard: EmployeeAttendanceDashboard
  workingHours: { start: string; end: string }
  projects: AttendanceProjectView[]
}

function fmtTime(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "—"
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
}

function deriveState(events: ClockEventLite[]): "IN" | "OUT" {
  const last = [...events]
    .reverse()
    .find((e) => e.kind === "CLOCK_IN" || e.kind === "CLOCK_OUT")
  return last?.kind === "CLOCK_IN" ? "IN" : "OUT"
}

export function EmployeeAttendanceDashboardView({
  firstName,
  dashboard,
  workingHours,
  projects,
}: Props) {
  const state = deriveState(dashboard.todayEvents)
  const now = new Date()

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {fmtDate(now)}
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-foreground">
          Hello, {firstName} 👋
        </h2>
      </div>

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
          <Badge variant={state === "IN" ? "clocked-in" : "clocked-out"}>
            {state === "IN" ? "On the clock" : "Not started"}
          </Badge>
        </div>
      </Card>

      <ClockCard
        state={state}
        projects={projects}
        activeProject={dashboard.today?.project ?? null}
        now={now.toISOString()}
      />

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
                        : "Break"}
                  </Badge>
                  <span className="text-sm font-semibold text-foreground">
                    {fmtTime(e.eventAt)}
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
                className={cn(
                  "flex items-center gap-3 rounded-xl border-l-4 bg-card px-4 py-3 shadow-panel",
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
                  <p className="truncate text-sm font-semibold text-foreground">{r.date}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtTime(r.timeIn)}{" "}
                    {r.timeOut ? `– ${fmtTime(r.timeOut)}` : ""}{" "}
                    {r.project ? `• ${r.project}` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-bold text-muted-foreground">
                  {r.durationMin
                    ? `${Math.floor(r.durationMin / 60)}h ${r.durationMin % 60}m`
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
