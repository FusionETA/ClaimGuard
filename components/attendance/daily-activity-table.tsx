"use client"

import { useState } from "react"
import Link from "next/link"
import { ChevronDown, ChevronUp } from "lucide-react"
import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CoordsLink } from "@/components/attendance/coords-link"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"
import type { AttendanceSessionView } from "@/modules/attendance/domain/models"

export type DailyActivityDerivedStatus =
  | "WORKING"
  | "ON_BREAK"
  | "CLOCKED_OUT"
  | "NOT_CLOCKED_IN"
  | "ON_LEAVE"

export type DailyActivityRow = {
  id: string
  name: string
  jobTitle: string | null
  project: string | null
  timeIn: string | null
  timeOut: string | null
  status: string | null
  derivedStatus?: DailyActivityDerivedStatus | null
  clockInDistanceMeters?: number | null
  /// GPS coords captured at each event when the employee's policy
  /// permits location capture. Null when capture was off or the
  /// browser couldn't get a fix. Drives the inline "Open in Maps"
  /// link below each timestamp.
  clockInLat?: number | null
  clockInLng?: number | null
  clockOutLat?: number | null
  clockOutLng?: number | null
  offSite?: boolean
  sessions?: AttendanceSessionView[]
}

type FilterBarProps = {
  prefix: string
  projects: { id: string; name: string }[]
  teams: { id: string; name: string; projectName: string }[]
  value: TableFilterValue
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "long" }

function formatTime(iso: string | null, tz: string): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString("en-MY", { ...TIME_FORMAT, timeZone: tz })
}

function statusBadge(s: DailyActivityDerivedStatus | null | undefined) {
  switch (s) {
    case "WORKING":
      return <Badge variant="clocked-in">Working</Badge>
    case "ON_BREAK":
      return <Badge variant="late">On break</Badge>
    case "CLOCKED_OUT":
      return <Badge variant="clocked-out">Clocked out</Badge>
    case "ON_LEAVE":
      return <Badge variant="on-leave">On leave</Badge>
    case "NOT_CLOCKED_IN":
      return <Badge variant="missing">Not clocked in</Badge>
    default:
      return <span className="text-muted-foreground">—</span>
  }
}

function SessionsExpander({
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
        {sessions.length} sessions
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
                className="grid grid-cols-[16px_1fr_auto_1fr] items-center gap-x-2 px-3 py-2 text-xs"
              >
                <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="flex items-center gap-1 font-semibold text-foreground">
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
                <span className="flex items-center gap-1 text-foreground">
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

export function DailyActivityTable({
  rows,
  timezone,
  filterBar,
}: {
  rows: DailyActivityRow[]
  timezone: string
  filterBar?: FilterBarProps
}) {
  const todayLabel = new Intl.DateTimeFormat("en-MY", {
    ...DATE_FORMAT,
    timeZone: timezone,
  }).format(new Date())

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle>Daily activity</CardTitle>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {todayLabel}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {filterBar ? (
          <TableFilterBar
            prefix={filterBar.prefix}
            projects={filterBar.projects}
            teams={filterBar.teams}
            value={filterBar.value}
          />
        ) : null}
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
            No employees yet.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="hidden grid-cols-[2fr_2fr_1fr_1fr_1.2fr] gap-3 px-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:grid">
              <span>Employee</span>
              <span>Project / Job</span>
              <span>Clock in</span>
              <span>Clock out</span>
              <span>Status</span>
            </div>
            {rows.map((row) => {
              const inLabel = formatTime(row.timeIn, timezone)
              const outLabel = formatTime(row.timeOut, timezone)
              const meta =
                [row.project, row.jobTitle].filter(Boolean).join(" · ") || "—"
              const sessions = row.sessions ?? []
              const sessionCount = sessions.length
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-1 gap-1 rounded-2xl border border-border/60 bg-surface-low px-4 py-3 sm:grid-cols-[2fr_2fr_1fr_1fr_1.2fr] sm:items-start sm:gap-3 sm:pt-3.5"
                >
                  <div className="min-w-0">
                    <Link
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      href={`/admin/attendance/employees/${row.id}` as any}
                      className="truncate text-sm font-bold hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.offSite ? (
                      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        Off-site
                        {row.clockInDistanceMeters != null
                          ? ` · ${Math.round(row.clockInDistanceMeters)}m`
                          : ""}
                      </p>
                    ) : null}
                    {sessionCount > 1 ? (
                      <SessionsExpander sessions={sessions} timezone={timezone} />
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground sm:text-sm sm:pt-0.5">
                    {meta}
                  </p>
                  <div className="text-sm">
                    <span className="sm:hidden text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Clock in:{" "}
                    </span>
                    {inLabel ?? <span className="text-muted-foreground">—</span>}
                    {row.clockInLat != null && row.clockInLng != null ? (
                      <CoordsLink
                        lat={row.clockInLat}
                        lng={row.clockInLng}
                        className="mt-0.5 flex flex-wrap items-center gap-x-1"
                      />
                    ) : null}
                  </div>
                  <div className="text-sm">
                    <span className="sm:hidden text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Clock out:{" "}
                    </span>
                    {outLabel ? (
                      outLabel
                    ) : inLabel ? (
                      <span className="italic text-muted-foreground">
                        Still working
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {outLabel &&
                    row.clockOutLat != null &&
                    row.clockOutLng != null ? (
                      <CoordsLink
                        lat={row.clockOutLat}
                        lng={row.clockOutLng}
                        className="mt-0.5 flex flex-wrap items-center gap-x-1"
                      />
                    ) : null}
                  </div>
                  <div className="flex items-center pt-0.5">
                    {statusBadge(row.derivedStatus ?? null)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
