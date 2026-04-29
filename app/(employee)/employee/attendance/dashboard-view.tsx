"use client"

import { useState } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Fingerprint,
  MapPin,
} from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import type { EmployeeAttendanceDashboard } from "@/modules/attendance/domain/models"
import { mockProjects } from "@/modules/attendance/infrastructure/mock-data"
import { cn } from "@/lib/utils"

type Props = {
  firstName: string
  dashboard: EmployeeAttendanceDashboard
}

export function EmployeeAttendanceDashboardView({ firstName, dashboard }: Props) {
  const [selectedProject, setSelectedProject] = useState(mockProjects[0])
  const [showDrop, setShowDrop] = useState(false)

  const now = new Date()
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })

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

      <div className="relative">
        <button
          onClick={() => setShowDrop((v) => !v)}
          className="flex w-full items-center justify-between rounded-xl border border-border/60 bg-card px-4 py-3 shadow-ambient transition active:scale-[0.99]"
        >
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" fill="currentColor" />
            <div className="text-left">
              <p className="text-[11px] font-semibold text-muted-foreground">
                Active Project
              </p>
              <p className="text-sm font-bold text-foreground">{selectedProject.name}</p>
            </div>
          </div>
          <ChevronDown
            className={cn(
              "h-5 w-5 text-muted-foreground transition-transform",
              showDrop && "rotate-180",
            )}
          />
        </button>
        {showDrop && (
          <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-xl border border-border/60 bg-card shadow-panel">
            {mockProjects.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedProject(p)
                  setShowDrop(false)
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-secondary/40",
                  p.id === selectedProject.id && "bg-secondary/40",
                )}
              >
                <Building2 className="h-4 w-4 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{p.name}</p>
                  <p className="text-[11px] text-muted-foreground">{p.address}</p>
                </div>
                {p.id === selectedProject.id && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-panel">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Today&apos;s Status
            </p>
            <p className="mt-0.5 text-3xl font-extrabold text-foreground">{timeStr}</p>
          </div>
          <Badge variant="clocked-out">Not Started</Badge>
        </div>

        <Link href="/employee/attendance/clock">
          <button className="group flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-secondary bg-secondary/40 py-6 transition hover:bg-secondary/60 active:scale-95">
            <div className="relative mb-2 flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-panel">
              <div className="absolute h-20 w-20 animate-ping2 rounded-full bg-primary opacity-20" />
              <Fingerprint className="h-10 w-10 text-primary-foreground" />
            </div>
            <p className="text-sm font-bold text-primary">Tap to Clock In</p>
          </button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "This Week", value: "32.5h", sub: "total hours" },
          { label: "Days Present", value: "4 / 5", sub: "this week" },
        ].map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-border/60 bg-card p-4 shadow-panel"
          >
            <p className="mt-2 text-2xl font-extrabold text-foreground">{c.value}</p>
            <p className="text-[11px] font-semibold text-muted-foreground">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-panel">
        <div className="relative flex h-36 items-center justify-center bg-gradient-to-br from-muted/60 to-muted">
          <div
            className="absolute inset-0 opacity-30"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg,transparent,transparent 19px,hsl(var(--border)) 19px,hsl(var(--border)) 20px), repeating-linear-gradient(90deg,transparent,transparent 19px,hsl(var(--border)) 19px,hsl(var(--border)) 20px)",
            }}
          />
          <div className="relative flex items-center justify-center">
            <div className="z-10 h-4 w-4 rounded-full border-2 border-card bg-primary shadow" />
            <div className="absolute h-4 w-4 animate-ping rounded-full bg-primary opacity-40" />
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-3">
          <MapPin className="h-4 w-4 text-primary" fill="currentColor" />
          <div>
            <p className="text-xs font-bold text-foreground">{selectedProject.name}</p>
            <p className="text-[11px] text-muted-foreground">{selectedProject.address}</p>
          </div>
        </div>
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
