import { AlertTriangle, CheckCircle2, Coffee, Fingerprint, LogOut } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import type {
  ClockEventLite,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

import {
  clockInAction,
  clockOutAction,
  confirmBreakAction,
} from "./actions"

type Props = {
  firstName: string
  dashboard: EmployeeAttendanceDashboard
  workingHours: { start: string; end: string }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  })
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

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Right now
            </p>
            <p className="mt-0.5 text-3xl font-extrabold text-foreground">
              {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        </div>

        {state === "OUT" ? (
          <form action={clockInAction}>
            <button
              type="submit"
              className="group flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-secondary bg-secondary/40 py-6 transition hover:bg-secondary/60 active:scale-95"
            >
              <div className="relative mb-2 flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-panel">
                <div className="absolute h-20 w-20 animate-ping2 rounded-full bg-primary opacity-20" />
                <Fingerprint className="h-10 w-10 text-primary-foreground" />
              </div>
              <p className="text-sm font-bold text-primary">Tap to Clock In</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Pending supervisor approval after tap
              </p>
            </button>
          </form>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <form action={confirmBreakAction}>
              <button
                type="submit"
                className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-secondary bg-secondary/40 py-5 transition hover:bg-secondary/60 active:scale-95"
              >
                <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                  <Coffee className="h-6 w-6" />
                </div>
                <p className="text-sm font-bold text-foreground">Confirm Break</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Still on site</p>
              </button>
            </form>

            <form action={clockOutAction}>
              <button
                type="submit"
                className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-destructive/40 bg-destructive/5 py-5 transition hover:bg-destructive/10 active:scale-95"
              >
                <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
                  <LogOut className="h-6 w-6" />
                </div>
                <p className="text-sm font-bold text-destructive">Clock Out</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">End shift</p>
              </button>
            </form>
          </div>
        )}
      </Card>

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
                    {r.timeIn ? fmtTime(r.timeIn) : "—"}{" "}
                    {r.timeOut ? `– ${fmtTime(r.timeOut)}` : ""}
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
