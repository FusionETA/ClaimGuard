"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { CoordsLink } from "@/components/attendance/coords-link"
import { SessionEditorDialog } from "@/components/attendance/session-editor-dialog"
import { PaginationControls } from "@/components/ui/pagination-controls"
import { attendanceStatusMeta } from "@/modules/attendance/domain/metadata"
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

const PAGE_SIZE = 5

function fmtTime(iso: string | null, tz: string) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      })
    : "—"
}

/**
 * Recent attendance list with a date-range filter, client-side pagination,
 * and per-row expandable off-site remarks + adjustment-request text. Rendered
 * inside `EmployeeDetailView` so both the admin and supervisor detail pages
 * get it.
 *
 * The parent loads ~1 month of records once; filtering/paging happens here so
 * there's no server round-trip and it works identically for both flows.
 */
export function RecentAttendancePanel({
  records,
  timezone,
  canEdit,
}: {
  records: AttendanceRecordView[]
  timezone: string
  canEdit: boolean
}) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // r.date is an ISO "yyyy-mm-dd" string, as are the date inputs, so plain
  // lexicographic comparison is a correct date comparison here.
  const filtered = useMemo(
    () =>
      records.filter((r) => {
        if (from && r.date < from) return false
        if (to && r.date > to) return false
        return true
      }),
    [records, from, to],
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const hasFilter = from !== "" || to !== ""

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-foreground">Recent attendance</p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              From
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              To
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => {
                  setTo(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              />
            </label>
            {hasFilter ? (
              <button
                type="button"
                onClick={() => {
                  setFrom("")
                  setTo("")
                  setPage(1)
                }}
                className="text-[11px] font-semibold text-primary hover:underline"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {records.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No attendance records in the last 30 days.
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No records in this date range.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {pageRows.map((r) => {
                const remarkCount = r.notes ? r.notes.split("\n").length : 0
                const notesOpen = expanded.has(`${r.id}:notes`)
                const remarkOpen = expanded.has(`${r.id}:remark`)
                return (
                  <div
                    key={r.id}
                    className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    {r.status === "MISSING" ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    ) : (
                      <CheckCircle2
                        className={cn(
                          "mt-0.5 h-4 w-4 shrink-0",
                          r.status === "ON_TIME" ? "text-success" : "text-tertiary",
                        )}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {r.date}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fmtTime(r.timeIn, timezone)}{" "}
                        {r.timeOut ? `– ${fmtTime(r.timeOut, timezone)}` : ""}{" "}
                        {r.project ? `• ${r.project}` : ""}
                      </p>
                      {r.clockInLat != null && r.clockInLng != null ? (
                        <div className="mt-0.5">
                          <CoordsLink
                            lat={r.clockInLat}
                            lng={r.clockInLng}
                            label="Clock-in map"
                          />
                        </div>
                      ) : null}
                      {r.timeOut &&
                      r.clockOutLat != null &&
                      r.clockOutLng != null ? (
                        <div className="mt-0.5">
                          <CoordsLink
                            lat={r.clockOutLat}
                            lng={r.clockOutLng}
                            label="Clock-out map"
                          />
                        </div>
                      ) : null}
                      {r.notes ? (
                        <div className="mt-1">
                          <button
                            type="button"
                            onClick={() => toggle(`${r.id}:notes`)}
                            className="flex items-center gap-0.5 text-[11px] font-semibold text-amber-700 hover:underline"
                          >
                            ⚠ {remarkCount} off-site remark
                            {remarkCount > 1 ? "s" : ""}
                            {notesOpen ? (
                              <ChevronUp className="h-3 w-3" />
                            ) : (
                              <ChevronDown className="h-3 w-3" />
                            )}
                          </button>
                          {notesOpen ? (
                            <pre className="mt-1 whitespace-pre-wrap rounded-md border border-amber-200 bg-amber-50 p-2 font-sans text-[11px] text-amber-900">
                              {r.notes}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}
                      {r.remark ? (
                        <div className="mt-1">
                          <button
                            type="button"
                            onClick={() => toggle(`${r.id}:remark`)}
                            className="flex items-center gap-0.5 text-[11px] font-semibold text-sky-700 hover:underline"
                          >
                            ✏️ Adjustment request
                            {remarkOpen ? (
                              <ChevronUp className="h-3 w-3" />
                            ) : (
                              <ChevronDown className="h-3 w-3" />
                            )}
                          </button>
                          {remarkOpen ? (
                            <pre className="mt-1 whitespace-pre-wrap rounded-md border border-sky-200 bg-sky-50 p-2 font-sans text-[11px] text-sky-900">
                              {r.remark}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <Badge variant={STATUS_VARIANT[r.status] as never}>
                      {attendanceStatusMeta[r.status].label}
                    </Badge>
                    {canEdit ? (
                      <SessionEditorDialog
                        recordId={r.id}
                        employeeId={r.employeeId}
                        initialTimeIn={r.timeIn}
                        initialTimeOut={r.timeOut}
                        triggerLabel="Edit"
                        contextLabel={`Record · ${r.date}`}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
            <PaginationControls
              className="mt-3 flex flex-wrap items-center justify-between gap-2"
              currentPage={safePage}
              pageSize={PAGE_SIZE}
              totalItems={filtered.length}
              itemLabel="records"
              onPageChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
