"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { Search } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"
import { SelfieThumbnail } from "@/components/attendance/selfie-thumbnail"
import { PaginationControls } from "@/components/ui/pagination-controls"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type AuditChainEntry = {
  step: number
  approverId: string
  approverName: string
  reviewedAt: string
  status: "APPROVED" | "REJECTED"
  notes: string | null
}

export type AuditLogRow = {
  id: string
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK" | "OT"
  status: "APPROVED" | "REJECTED" | "PENDING"
  employeeId: string
  employeeName: string
  reviewerId: string | null
  reviewerName: string | null
  eventAt: string | null
  reviewedAt: string | null
  delayMinutes: number | null
  project: string | null
  title: string
  chainHistory: AuditChainEntry[] | null
  selfieAttendanceRecordId: string | null
  /** When the supervisor adjusted the clock-in/out time during approval,
   *  this is the new timestamp written to the AttendanceRecord. Null for
   *  approvals that accepted the original event time as-is. */
  overrideAt: string | null
  /** Optional free-text reason captured alongside the override. */
  overrideReason: string | null
  otStartAt: string | null
  otEndAt: string | null
}

type LoadAction = (
  fromIso: string,
  toIso: string,
  projectId?: string | null,
) => Promise<AuditLogRow[]>

import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"

type FilterBarProps = {
  prefix: string
  projects: { id: string; name: string }[]
  teams: { id: string; name: string; projectName: string }[]
  value: TableFilterValue
}

type Props = {
  initialFrom: string
  initialTo: string
  initialRows: AuditLogRow[]
  loadAction: LoadAction
  /** When the parent's project filter changes, the panel re-fetches automatically. */
  projectId?: string | null
  filterBar?: FilterBarProps
}

const KIND_LABEL: Record<AuditLogRow["kind"], string> = {
  CLOCK_IN: "Clock in",
  CLOCK_OUT: "Clock out",
  BREAK: "Break",
  OT: "OT",
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtOtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtOtDuration(startIso: string, endIso: string): string {
  const diffMin = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  )
  if (diffMin <= 0) return ""
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function fmtDelay(min: number | null): string {
  if (min === null) return "—"
  if (Math.abs(min) < 1) return "instant"
  if (Math.abs(min) < 60) return `${min}m`
  const h = Math.floor(Math.abs(min) / 60)
  const m = Math.abs(min) % 60
  return `${min < 0 ? "−" : ""}${h}h ${m}m`
}

type KindFilter = "ALL" | AuditLogRow["kind"]
type StatusFilter = "ALL" | AuditLogRow["status"]

const STATUS_PILLS: { key: StatusFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "APPROVED", label: "Approved" },
  { key: "PENDING", label: "Pending" },
  { key: "REJECTED", label: "Rejected" },
]

export function ApprovalAuditLog({
  initialFrom,
  initialTo,
  initialRows,
  loadAction,
  projectId,
  filterBar,
}: Props) {
  const headingTitle = "Approvals"
  const headingSubtitle =
    "Clock-in / clock-out / break / OT requests. Filter by status with the pills below; Δ vs event shows the review delay."
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [rows, setRows] = useState<AuditLogRow[]>(initialRows)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [appliedProjectId, setAppliedProjectId] = useState<string | null | undefined>(
    projectId,
  )
  const [search, setSearch] = useState("")
  const [kindFilter, setKindFilter] = useState<KindFilter>("ALL")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [page, setPage] = useState(1)

  // Mirror server-supplied rows whenever the parent re-renders with a
  // new payload. Without this sync, useState(initialRows) only fires on
  // first mount, so switching the active company at the page level
  // doesn't update the audit log table — the parent re-fetches but the
  // component keeps its stale state. setRows on the same reference is
  // a no-op so this doesn't cause extra re-renders.
  useEffect(() => {
    setRows(initialRows)
  }, [initialRows])

  // Refetch when the parent's project filter changes.
  useEffect(() => {
    if (appliedProjectId === projectId) return
    setAppliedProjectId(projectId)
    startTransition(async () => {
      try {
        const next = await loadAction(from, to, projectId ?? null)
        setRows(next)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit log")
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  function handleApply() {
    setError(null)
    if (!from || !to) {
      setError("Pick both a start and end date")
      return
    }
    if (from > to) {
      setError("Start date must be on or before end date")
      return
    }
    startTransition(async () => {
      try {
        const next = await loadAction(from, to, projectId ?? null)
        setRows(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit log")
      }
    })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows
      .filter((r) => {
        if (kindFilter !== "ALL" && r.kind !== kindFilter) return false
        if (statusFilter !== "ALL" && r.status !== statusFilter) return false
        if (q.length > 0) {
          const hay = [r.employeeName, r.reviewerName ?? "", r.project ?? ""]
            .join(" ")
            .toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? ""))
  }, [rows, search, kindFilter, statusFilter])

  // Per-status counts over the loaded rows, so each pill shows its own total.
  const statusCounts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      ALL: rows.length,
      APPROVED: 0,
      PENDING: 0,
      REJECTED: 0,
    }
    for (const r of rows) c[r.status] += 1
    return c
  }, [rows])

  const PAGE_SIZE = 12
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  // Snap back to page 1 when a filter narrows the set or a re-fetch swaps the
  // rows, so we never land on an empty tail page.
  useEffect(() => {
    setPage(1)
  }, [search, kindFilter, statusFilter, rows])

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-headline text-lg font-semibold text-foreground">
              {headingTitle}
            </h3>
            <p className="text-xs text-muted-foreground">{headingSubtitle}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="audit-from" className="text-[10px] uppercase tracking-wider">
                From
              </Label>
              <Input
                id="audit-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
            <div>
              <Label htmlFor="audit-to" className="text-[10px] uppercase tracking-wider">
                To
              </Label>
              <Input
                id="audit-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
            <Button type="button" size="sm" onClick={handleApply} disabled={pending}>
              {pending ? "Loading…" : "Apply"}
            </Button>
          </div>
        </div>

        {filterBar ? (
          <TableFilterBar
            prefix={filterBar.prefix}
            projects={filterBar.projects}
            teams={filterBar.teams}
            value={filterBar.value}
          />
        ) : null}

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {/* Status pills — replaces the old status dropdown and merges the
            former Approved + Pending/Rejected tables into one paginated list. */}
        <div className="flex flex-wrap gap-2">
          {STATUS_PILLS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setStatusFilter(p.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                statusFilter === p.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label} · {statusCounts[p.key]}
            </button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_180px] sm:gap-3">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search employee, reviewer, or project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
          <Select
            value={kindFilter}
            onValueChange={(v) => setKindFilter(v as KindFilter)}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All kinds</SelectItem>
              <SelectItem value="CLOCK_IN">Clock in</SelectItem>
              <SelectItem value="CLOCK_OUT">Clock out</SelectItem>
              <SelectItem value="BREAK">Break</SelectItem>
              <SelectItem value="OT">OT</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Showing {filtered.length} of {rows.length} approvals
        </p>

        {filtered.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {rows.length === 0
              ? "No approvals in this range."
              : "No rows match the current filters."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border border-border/40">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="bg-card py-2 pl-3 pr-3 font-semibold">Employee</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Kind</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Event</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Reviewed by</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Reviewed at</th>
                  <th className="bg-card py-2 pr-3 text-right font-semibold">Δ vs event</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/30 text-foreground"
                  >
                    <td className="py-2 pl-3 pr-3">
                      <div className="flex items-center gap-2">
                        {row.selfieAttendanceRecordId ? (
                          <SelfieThumbnail
                            recordId={row.selfieAttendanceRecordId}
                            size={36}
                          />
                        ) : null}
                        <div>
                          <div className="font-medium">{row.employeeName}</div>
                          {row.project ? (
                            <div className="text-[10px] text-muted-foreground">
                              {row.project}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs">{KIND_LABEL[row.kind]}</td>
                    <td className="py-2 pr-3 text-xs tabular-nums">
                      {row.kind === "OT" && row.otStartAt && row.otEndAt ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">
                            {fmtOtTime(row.otStartAt)} – {fmtOtTime(row.otEndAt)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {fmtOtDuration(row.otStartAt, row.otEndAt)} · {fmtShortDate(row.otStartAt)}
                          </span>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <span
                            className={
                              row.overrideAt
                                ? "text-muted-foreground line-through"
                                : ""
                            }
                          >
                            {row.eventAt ? fmtDateTime(row.eventAt) : "—"}
                          </span>
                          {row.overrideAt ? (
                            <span className="flex items-center gap-1 text-[11px] font-semibold text-primary">
                              <span>→ {fmtDateTime(row.overrideAt)}</span>
                              <Badge
                                variant="overtime"
                                className="px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider"
                              >
                                Adjusted
                              </Badge>
                            </span>
                          ) : null}
                          {row.overrideAt && row.overrideReason ? (
                            <span className="text-[10px] text-muted-foreground">
                              {row.overrideReason}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {row.chainHistory && row.chainHistory.length > 0 ? (
                        <div className="space-y-0.5">
                          {row.chainHistory.map((h) => (
                            <div
                              key={`${h.step}-${h.approverId}`}
                              className="text-[11px]"
                            >
                              <span className="text-muted-foreground">
                                Step {h.step}:
                              </span>{" "}
                              <span className="font-medium">{h.approverName}</span>
                              {h.status === "REJECTED" ? (
                                <span className="text-destructive"> (rejected)</span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : row.reviewerName ? (
                        row.reviewerName
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs tabular-nums">
                      {row.reviewedAt ? (
                        fmtDateTime(row.reviewedAt)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right text-xs tabular-nums">
                      {fmtDelay(row.delayMinutes)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        variant={
                          row.status === "APPROVED"
                            ? "approved"
                            : row.status === "REJECTED"
                              ? "rejected"
                              : "pending"
                        }
                      >
                        {row.status === "APPROVED"
                          ? "Approved"
                          : row.status === "REJECTED"
                            ? "Rejected"
                            : "Pending"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <PaginationControls
              className="flex flex-wrap items-center justify-between gap-3 pt-1"
              currentPage={currentPage}
              pageSize={PAGE_SIZE}
              totalItems={filtered.length}
              itemLabel="approvals"
              onPageChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
