"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Coffee, Fingerprint, LogOut } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import type { EmployeeAttendanceDashboard } from "@/modules/attendance/domain/models"
import { mockWorkingHours } from "@/modules/attendance/infrastructure/mock-data"
import { cn } from "@/lib/utils"

type ClockState = "OUT" | "IN"

type ClockEvent = {
  kind: "IN" | "OUT" | "BREAK"
  at: Date
}

type Props = {
  firstName: string
  dashboard: EmployeeAttendanceDashboard
}

function fmt(d: Date) {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

export function EmployeeAttendanceDashboardView({ firstName, dashboard }: Props) {
  const [events, setEvents] = useState<ClockEvent[]>([])
  const lastClockEvent = [...events]
    .reverse()
    .find((e) => e.kind === "IN" || e.kind === "OUT")
  const state: ClockState = lastClockEvent?.kind === "IN" ? "IN" : "OUT"

  const today = new Date()
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })

  function record(kind: ClockEvent["kind"]) {
    setEvents((prev) => [...prev, { kind, at: new Date() }])
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {dateStr}
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
              {mockWorkingHours.start} – {mockWorkingHours.end}
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
              {fmt(today)}
            </p>
          </div>
        </div>

        {state === "OUT" ? (
          <button
            onClick={() => record("IN")}
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
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => record("BREAK")}
              className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-secondary bg-secondary/40 py-5 transition hover:bg-secondary/60 active:scale-95"
            >
              <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <Coffee className="h-6 w-6" />
              </div>
              <p className="text-sm font-bold text-foreground">Confirm Break</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Still on site</p>
            </button>

            <button
              onClick={() => record("OUT")}
              className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-destructive/40 bg-destructive/5 py-5 transition hover:bg-destructive/10 active:scale-95"
            >
              <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
                <LogOut className="h-6 w-6" />
              </div>
              <p className="text-sm font-bold text-destructive">Clock Out</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">End shift</p>
            </button>
          </div>
        )}
      </Card>

      {events.length > 0 ? (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-sm font-bold text-foreground">Today&apos;s events</p>
            <div className="space-y-2">
              {events.map((e, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 border-b border-border/50 py-2 last:border-0"
                >
                  <Badge
                    variant={
                      e.kind === "IN"
                        ? "clocked-in"
                        : e.kind === "OUT"
                          ? "clocked-out"
                          : "pending"
                    }
                  >
                    {e.kind === "IN"
                      ? "Clock in"
                      : e.kind === "OUT"
                        ? "Clock out"
                        : "Break"}
                  </Badge>
                  <span className="text-sm font-semibold text-foreground">{fmt(e.at)}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    Pending approval
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "This Week", value: "32.5h", sub: "total hours" },
          { label: "Days Present", value: "4 / 5", sub: "this week" },
        ].map((c) => (
          <Card key={c.label} className="p-4">
            <p className="mt-2 text-2xl font-extrabold text-foreground">{c.value}</p>
            <p className="text-[11px] font-semibold text-muted-foreground">{c.sub}</p>
          </Card>
        ))}
      </div>

      <div>
        <p className="mb-2 text-sm font-bold text-foreground">Recent Shifts</p>
        <div className="space-y-2">
          {dashboard.weekToDate.slice(0, 3).map((r) => (
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
                  {r.timeIn} {r.timeOut ? `– ${r.timeOut}` : ""}
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
      </div>
    </div>
  )
}
