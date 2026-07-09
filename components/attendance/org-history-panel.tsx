"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CoordsLink } from "@/components/attendance/coords-link"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"
import { ExportPdfDialog } from "@/components/admin/export-pdf-dialog"
import { attendanceStatusMeta } from "@/modules/attendance/domain/metadata"
import type { AttendanceRecordView } from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

const PAGE_SIZE = 50

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "ON_TIME", label: "On time" },
  { value: "LATE", label: "Late" },
  { value: "MISSING", label: "Missing" },
  { value: "CLOCKED_IN", label: "Clocked in" },
  { value: "CLOCKED_OUT", label: "Clocked out" },
  { value: "ON_LEAVE", label: "On leave" },
]

const STATUS_BADGE: Record<string, string> = {
  ON_TIME: "on-time",
  LATE: "late",
  MISSING: "missing",
  CLOCKED_IN: "clocked-in",
  CLOCKED_OUT: "clocked-out",
  ON_LEAVE: "on-leave",
}

function fmtTime(iso: string | null, tz: string): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleTimeString("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  })
}

function fmtDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: tz,
  })
}

function fmtHours(min: number | null): string {
  if (!min) return "—"
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

type LoadAction = (
  fromIso: string,
  toIso: string,
  projectId: string | null,
  teamId: string | null,
  q: string | null,
  statuses: string[],
  page: number,
) => Promise<{ rows: AttendanceRecordView[]; total: number }>

export function OrgHistoryPanel({
  initialFrom,
  initialTo,
  initialRows,
  initialTotal,
  loadAction,
  projects,
  teams,
  timezone,
  employees,
}: {
  initialFrom: string
  initialTo: string
  initialRows: AttendanceRecordView[]
  initialTotal: number
  loadAction: LoadAction
  projects: { id: string; name: string }[]
  teams: { id: string; name: string; projectName: string }[]
  timezone: string
  employees: { id: string; name: string }[]
}) {
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [filter, setFilter] = useState<TableFilterValue>({
    projectId: null,
    teamId: null,
    q: null,
  })
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState(initialRows)
  const [total, setTotal] = useState(initialTotal)
  const [isPending, startTransition] = useTransition()

  function reload(
    nextFrom: string,
    nextTo: string,
    nextFilter: TableFilterValue,
    nextStatuses: string[],
    nextPage: number,
  ) {
    startTransition(async () => {
      const result = await loadAction(
        nextFrom,
        nextTo,
        nextFilter.projectId ?? null,
        nextFilter.teamId ?? null,
        nextFilter.q ?? null,
        nextStatuses,
        nextPage,
      )
      setRows(result.rows)
      setTotal(result.total)
    })
  }

  function handleFrom(v: string) {
    setFrom(v)
    setPage(0)
    reload(v, to, filter, selectedStatuses, 0)
  }

  function handleTo(v: string) {
    setTo(v)
    setPage(0)
    reload(from, v, filter, selectedStatuses, 0)
  }

  function handleFilter(next: TableFilterValue) {
    setFilter(next)
    setPage(0)
    reload(from, to, next, selectedStatuses, 0)
  }

  function toggleStatus(s: string) {
    const next = selectedStatuses.includes(s)
      ? selectedStatuses.filter((x) => x !== s)
      : [...selectedStatuses, s]
    setSelectedStatuses(next)
    setPage(0)
    reload(from, to, filter, next, 0)
  }

  function clearStatuses() {
    setSelectedStatuses([])
    setPage(0)
    reload(from, to, filter, [], 0)
  }

  function goPage(next: number) {
    setPage(next)
    reload(from, to, filter, selectedStatuses, next)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const start = page * PAGE_SIZE + 1
  const end = Math.min((page + 1) * PAGE_SIZE, total)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Attendance history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Date range */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              From
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => handleFrom(e.target.value)}
              className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              To
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => handleTo(e.target.value)}
              className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
          <ExportPdfDialog
            kind="attendance"
            initialFrom={from}
            initialTo={to}
            employees={employees}
          />
        </div>

        {/* Search + project/team filter */}
        <TableFilterBar
          prefix="hist"
          projects={projects}
          teams={teams}
          value={filter}
          onChange={handleFilter}
        />

        {/* Status filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={clearStatuses}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
              selectedStatuses.length === 0
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            All
          </button>
          {STATUS_OPTIONS.map((s) => {
            const active = selectedStatuses.includes(s.value)
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => toggleStatus(s.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            )
          })}
        </div>

        {/* Table */}
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-8 text-center text-sm text-muted-foreground">
            No records found for this range.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="hidden grid-cols-[1fr_1.4fr_1fr_1fr_1fr_0.7fr_1fr] gap-3 px-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:grid">
              <span>Date</span>
              <span>Employee</span>
              <span>Project</span>
              <span>Clock in</span>
              <span>Clock out</span>
              <span>Hours</span>
              <span>Status</span>
            </div>
            {rows.map((row) => {
              const inTime = fmtTime(row.timeIn, timezone)
              const outTime = fmtTime(row.timeOut, timezone)
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-1 gap-1 rounded-2xl border border-border/60 bg-surface-low px-4 py-3 sm:grid-cols-[1fr_1.4fr_1fr_1fr_1fr_0.7fr_1fr] sm:items-center sm:gap-3"
                >
                  <p className="text-xs font-semibold text-foreground sm:text-sm">
                    {fmtDate(row.date, timezone)}
                  </p>
                  <Link
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    href={`/admin/attendance/employees/${row.employeeId}` as any}
                    className="truncate text-sm font-bold hover:underline"
                  >
                    {row.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.project ?? "—"}
                  </p>
                  <div className="text-xs sm:text-sm">
                    <span className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      In:{" "}
                    </span>
                    {inTime}
                    {row.clockInLat != null && row.clockInLng != null ? (
                      <CoordsLink
                        lat={row.clockInLat}
                        lng={row.clockInLng}
                        showCoords={false}
                        label=""
                      />
                    ) : null}
                  </div>
                  <div className="text-xs sm:text-sm">
                    <span className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Out:{" "}
                    </span>
                    {outTime}
                    {row.clockOutLat != null && row.clockOutLng != null ? (
                      <CoordsLink
                        lat={row.clockOutLat}
                        lng={row.clockOutLng}
                        showCoords={false}
                        label=""
                      />
                    ) : null}
                  </div>
                  <p className="text-xs font-semibold text-foreground">
                    {fmtHours(row.durationMin ?? null)}
                  </p>
                  <div>
                    <Badge variant={STATUS_BADGE[row.status] as never}>
                      {attendanceStatusMeta[row.status as keyof typeof attendanceStatusMeta]
                        ?.label ?? row.status}
                    </Badge>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {total === 0 ? "No records" : `${start}–${end} of ${total}`}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page === 0 || isPending}
                onClick={() => goPage(page - 1)}
                className="rounded-lg border border-border/60 p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-2 text-xs text-muted-foreground">
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1 || isPending}
                onClick={() => goPage(page + 1)}
                className="rounded-lg border border-border/60 p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : total > 0 ? (
          <p className="text-xs text-muted-foreground">
            {total} record{total !== 1 ? "s" : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
