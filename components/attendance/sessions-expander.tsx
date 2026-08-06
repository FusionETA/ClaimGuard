"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { CoordsLink } from "@/components/attendance/coords-link"
import type { AttendanceSessionView } from "@/modules/attendance/domain/models"

function formatTime(iso: string | null, tz: string): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  })
}

/**
 * Collapsible list of a day's clock-in/out sessions ("shifts"). Shown on the
 * Daily activity + Attendance history rows when an employee clocked in more
 * than once in a day, so the main row can show just the latest shift while
 * the earlier ones stay one click away.
 */
export function SessionsExpander({
  sessions,
  timezone,
}: {
  sessions: AttendanceSessionView[]
  timezone: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        {sessions.length} shifts
        {open ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>
      {open ? (
        <div className="mt-2 rounded-xl border border-border/60 bg-background divide-y divide-border/40 overflow-hidden">
          {sessions.map((s, i) => {
            const sIn = formatTime(s.startedAt, timezone)
            const sOut = s.endedAt ? formatTime(s.endedAt, timezone) : null
            const hasInGps = s.clockInLat != null && s.clockInLng != null
            const hasOutGps = s.clockOutLat != null && s.clockOutLng != null
            return (
              <div
                key={s.id}
                className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-2 px-3 py-2 text-xs"
              >
                <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Shift {i + 1}
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap font-semibold text-foreground">
                  {sIn}
                  {hasInGps ? (
                    <CoordsLink
                      lat={s.clockInLat}
                      lng={s.clockInLng}
                      showCoords={false}
                      label=""
                    />
                  ) : null}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="flex items-center gap-1 whitespace-nowrap text-foreground">
                  {sOut ? (
                    <>
                      <span className="font-semibold">{sOut}</span>
                      {hasOutGps ? (
                        <CoordsLink
                          lat={s.clockOutLat}
                          lng={s.clockOutLng}
                          showCoords={false}
                          label=""
                        />
                      ) : null}
                    </>
                  ) : (
                    <span className="italic text-muted-foreground">working</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
