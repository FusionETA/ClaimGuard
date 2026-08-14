"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { SessionsExpander } from "@/components/attendance/sessions-expander"
import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PaginationControls } from "@/components/ui/pagination-controls"
import { CoordsLink } from "@/components/attendance/coords-link"
import { SelfieThumbnail } from "@/components/attendance/selfie-thumbnail"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"
import type { AttendanceSessionView } from "@/modules/attendance/domain/models"
import { formatDistance } from "@/lib/geo"
import { cn } from "@/lib/utils"

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
  /// True when the employee clocked in late today (any session flagged
  /// LATE). `lateByMin` is the minutes-late on the record, when known.
  late?: boolean
  lateByMin?: number | null
  attendanceRecordId?: string | null
  hasSelfie?: boolean
  hasClockOutSelfie?: boolean
  sessions?: AttendanceSessionView[]
}

type FilterBarProps = {
  prefix: string
  projects: { id: string; name: string }[]
  teams: { id: string; name: string; projectName: string }[]
  value: TableFilterValue
  /// Hide the Project dropdown (the supervisor Team view uses a ◄ ►
  /// ProjectSwitcher above the table instead).
  hideProject?: boolean
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

// Sort priority — actively working on top, not-clocked-in last.
const STATUS_ORDER: Record<DailyActivityDerivedStatus, number> = {
  WORKING: 0,
  ON_BREAK: 1,
  CLOCKED_OUT: 2,
  ON_LEAVE: 3,
  NOT_CLOCKED_IN: 4,
}

function isClockedIn(r: DailyActivityRow): boolean {
  return (
    r.derivedStatus === "WORKING" ||
    r.derivedStatus === "ON_BREAK" ||
    r.derivedStatus === "CLOCKED_OUT"
  )
}

type PillKey =
  | "all"
  | "on_time"
  | "late"
  | "on_site"
  | "off_site"
  | "no_clock_in"
  | "on_leave"

// Pills overlap on purpose: On time / Late split the clocked-in group by
// punctuality; On-site / Off-site split it by geofence. Both are sub-slices
// of "clocked in", so their counts intentionally don't sum to All.
const PILL_PREDICATES: Record<PillKey, (r: DailyActivityRow) => boolean> = {
  all: () => true,
  on_time: (r) => isClockedIn(r) && !r.late,
  late: (r) => isClockedIn(r) && !!r.late,
  on_site: (r) => isClockedIn(r) && !r.offSite,
  off_site: (r) => isClockedIn(r) && !!r.offSite,
  no_clock_in: (r) => r.derivedStatus === "NOT_CLOCKED_IN",
  on_leave: (r) => r.derivedStatus === "ON_LEAVE",
}

const PILLS: { key: PillKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "on_time", label: "On time" },
  { key: "late", label: "Late" },
  { key: "on_site", label: "On-site" },
  { key: "off_site", label: "Off-site" },
  { key: "no_clock_in", label: "No clock-in" },
  { key: "on_leave", label: "On leave" },
]

export function DailyActivityTable({
  rows,
  timezone,
  filterBar,
  employeeHrefBase = "/admin/attendance/employees",
  title = "Daily activity",
}: {
  rows: DailyActivityRow[]
  timezone: string
  filterBar?: FilterBarProps
  /// Base path each employee row links to (append `/${id}`). Admin uses
  /// the default; the supervisor Team view passes
  /// `/employee/attendance/team` so it stays inside the portal.
  employeeHrefBase?: string
  /// Card title. Defaults to the admin "Daily activity"; the supervisor
  /// Team view overrides it to "Your team today".
  title?: string
}) {
  const todayLabel = new Intl.DateTimeFormat("en-MY", {
    ...DATE_FORMAT,
    timeZone: timezone,
  }).format(new Date())

  const [statusFilter, setStatusFilter] = useState<PillKey>("all")
  const [page, setPage] = useState(1)

  const counts = useMemo(() => {
    const c: Record<PillKey, number> = {
      all: 0,
      on_time: 0,
      late: 0,
      on_site: 0,
      off_site: 0,
      no_clock_in: 0,
      on_leave: 0,
    }
    for (const r of rows) {
      for (const p of PILLS) {
        if (PILL_PREDICATES[p.key](r)) c[p.key] += 1
      }
    }
    return c
  }, [rows])

  const visibleRows = useMemo(() => {
    const filtered = rows.filter(PILL_PREDICATES[statusFilter])
    // Stable sort, clocked-in on top → not-clocked-in last.
    return [...filtered].sort((a, b) => {
      const oa = a.derivedStatus != null ? STATUS_ORDER[a.derivedStatus] : 5
      const ob = b.derivedStatus != null ? STATUS_ORDER[b.derivedStatus] : 5
      return oa - ob
    })
  }, [rows, statusFilter])

  const PAGE_SIZE = 15
  // Clamp `page` after visibleRows shrinks (filter tightens or a
  // re-fetch drops rows) so we don't render a blank page.
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pagedRows = useMemo(
    () =>
      visibleRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visibleRows, currentPage],
  )

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle>{title}</CardTitle>
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
            hideProject={filterBar.hideProject}
          />
        ) : null}
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
            No employees yet.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {PILLS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    setStatusFilter(f.key)
                    // Reset to page 1 whenever the filter changes so
                    // admins don't land on an empty tail page.
                    setPage(1)
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    statusFilter === f.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label} · {counts[f.key]}
                </button>
              ))}
            </div>
            {visibleRows.length === 0 ? (
              <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
                No employees match this filter.
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
                {pagedRows.map((row) => {
              const sessions = row.sessions ?? []
              const sessionCount = sessions.length
              // Multi-shift days: the CLOCK IN / CLOCK OUT columns show the
              // CURRENT (latest) shift; the full per-shift breakdown lives in
              // the "N shifts" expander below. Single-shift days are
              // unchanged (the latest session is the only session).
              const latestSession =
                sessionCount > 0 ? sessions[sessionCount - 1] : null
              const inLabel = formatTime(
                latestSession?.startedAt ?? row.timeIn,
                timezone,
              )
              const outLabel = formatTime(
                latestSession?.endedAt ?? row.timeOut,
                timezone,
              )
              const meta =
                [row.project, row.jobTitle].filter(Boolean).join(" · ") || "—"
              // Off-site clock-ins require a remark — surface it on the row.
              const offSiteReason = row.offSite
                ? (sessions.find((s) => s.clockInNotes?.trim())?.clockInNotes ??
                  null)
                : null
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-1 gap-1 rounded-2xl border border-border/60 bg-surface-low px-4 py-3 sm:grid-cols-[2fr_2fr_1fr_1fr_1.2fr] sm:items-start sm:gap-3 sm:pt-3.5"
                >
                  <div className="min-w-0">
                    <Link
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      href={`${employeeHrefBase}/${row.id}` as any}
                      className="block truncate text-sm font-bold hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.offSite ? (
                      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        Off-site
                        {row.clockInDistanceMeters != null
                          ? ` · ${formatDistance(row.clockInDistanceMeters)}`
                          : ""}
                      </p>
                    ) : null}
                    {offSiteReason ? (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        <span className="font-semibold text-foreground/80">
                          Reason:
                        </span>{" "}
                        {offSiteReason}
                      </p>
                    ) : null}
                    {row.late ? (
                      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
                        Late
                        {row.lateByMin != null ? ` · +${row.lateByMin}m` : ""}
                      </p>
                    ) : null}
                    {sessionCount > 1 ? (
                      <SessionsExpander sessions={sessions} timezone={timezone} />
                    ) : null}
                  </div>
                  <p className="min-w-0 truncate text-xs text-muted-foreground sm:text-sm sm:pt-0.5">
                    {meta}
                  </p>
                  <div className="text-sm">
                    <span className="sm:hidden text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Clock in:{" "}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {inLabel ?? <span className="text-muted-foreground">—</span>}
                      {row.hasSelfie && row.attendanceRecordId ? (
                        <SelfieThumbnail
                          recordId={row.attendanceRecordId}
                          phase="clock-in"
                          size={20}
                          className="rounded"
                        />
                      ) : null}
                    </span>
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
                    <span className="flex items-center gap-1.5">
                      {outLabel ? (
                        outLabel
                      ) : inLabel ? (
                        <span className="italic text-muted-foreground">
                          Still working
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {row.hasClockOutSelfie && row.attendanceRecordId ? (
                        <SelfieThumbnail
                          recordId={row.attendanceRecordId}
                          phase="clock-out"
                          size={20}
                          className="rounded"
                        />
                      ) : null}
                    </span>
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
                <PaginationControls
                  className="flex flex-wrap items-center justify-between gap-3 pt-2"
                  currentPage={currentPage}
                  pageSize={PAGE_SIZE}
                  totalItems={visibleRows.length}
                  itemLabel="employees"
                  onPageChange={setPage}
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
