"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { Search } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"
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
  status: "APPROVED" | "REJECTED"
  employeeId: string
  employeeName: string
  reviewerId: string | null
  reviewerName: string | null
  eventAt: string | null
  reviewedAt: string
  delayMinutes: number | null
  project: string | null
  title: string
  chainHistory: AuditChainEntry[] | null
}

type LoadAction = (
  fromIso: string,
  toIso: string,
  projectId?: string | null,
) => Promise<AuditLogRow[]>

type Props = {
  initialFrom: string
  initialTo: string
  initialRows: AuditLogRow[]
  loadAction: LoadAction
  /** When the parent's project filter changes, the panel re-fetches automatically. */
  projectId?: string | null
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

export function ApprovalAuditLog({
  initialFrom,
  initialTo,
  initialRows,
  loadAction,
  projectId,
}: Props) {
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
      .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
  }, [rows, search, kindFilter, statusFilter])

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-headline text-lg font-semibold text-foreground">
              Approval audit log
            </h3>
            <p className="text-xs text-muted-foreground">
              Reviewed clock-in / clock-out / break / OT requests. The
              <span className="font-semibold"> Δ vs event</span> column shows
              how long after the original event the supervisor reviewed it
              (positive = delayed approval).
            </p>
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

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-[1fr_160px_160px] sm:gap-3">
          <div className="relative">
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
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Showing {filtered.length} of {rows.length} reviewed approvals
        </p>

        {filtered.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {rows.length === 0
              ? "No reviewed approvals in this range."
              : "No rows match the current filters."}
          </p>
        ) : (
          <div className="max-h-[420px] overflow-auto rounded-md border border-border/40">
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
                {filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/30 text-foreground"
                  >
                    <td className="py-2 pl-3 pr-3">
                      <div className="font-medium">{row.employeeName}</div>
                      {row.project ? (
                        <div className="text-[10px] text-muted-foreground">
                          {row.project}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-xs">{KIND_LABEL[row.kind]}</td>
                    <td className="py-2 pr-3 text-xs tabular-nums">
                      {row.eventAt ? fmtDateTime(row.eventAt) : "—"}
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
                      {fmtDateTime(row.reviewedAt)}
                    </td>
                    <td className="py-2 pr-3 text-right text-xs tabular-nums">
                      {fmtDelay(row.delayMinutes)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        variant={
                          row.status === "APPROVED" ? "approved" : "rejected"
                        }
                      >
                        {row.status === "APPROVED" ? "Approved" : "Rejected"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
