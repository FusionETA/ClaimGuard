"use client"

import React, { useMemo, useState, useTransition } from "react"
import { ChevronDown, ChevronUp, FileText, Search } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  approvalStatusMeta,
} from "@/modules/attendance/domain/metadata"

import type { OtSubmissionRow } from "./actions"
import { loadOtSubmissionsAction } from "./actions"

type StatusFilter = "ALL" | "PENDING" | "APPROVED" | "REJECTED"

const APPROVAL_VARIANT: Record<string, string> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtDate(iso: string): string {
  // Date-only strings ("YYYY-MM-DD") are parsed directly to avoid
  // timezone/locale drift between server and client renders.
  if (iso.length === 10) {
    const [y, m, d] = iso.split("-")
    return `${parseInt(d!)} ${MONTHS[parseInt(m!) - 1]} ${y}`
  }
  // Full ISO datetime — timezone-dependent, suppress hydration warning at call site.
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function fmtDuration(startIso: string, endIso: string): string {
  const diffMin = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  )
  if (diffMin <= 0) return ""
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function fmtUploadedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function monthAgoIso() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

type Props = {
  initialRows: OtSubmissionRow[]
  initialFrom: string
  initialTo: string
}

export function OtAdminTable({ initialRows, initialFrom, initialTo }: Props) {
  const [rows, setRows] = useState(initialRows)
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [search, setSearch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function handleApply() {
    setError(null)
    if (!from || !to || from > to) {
      setError("Pick a valid date range.")
      return
    }
    const statuses: Array<"PENDING" | "APPROVED" | "REJECTED"> =
      statusFilter === "ALL"
        ? []
        : [statusFilter]
    startTransition(async () => {
      try {
        const next = await loadOtSubmissionsAction(from, to, statuses)
        setRows(next)
      } catch {
        setError("Failed to load OT submissions.")
      }
    })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== "ALL" && r.status !== statusFilter) return false
      if (q) {
        const hay = [r.employeeName, r.project ?? ""].join(" ").toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, statusFilter, search])

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        {/* Header + date range */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-headline text-lg font-semibold text-foreground">
              OT submissions
            </h3>
            <p className="text-xs text-muted-foreground">
              All overtime requests across the organisation.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="ot-from" className="text-[10px] uppercase tracking-wider">
                From
              </Label>
              <Input
                id="ot-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
            <div>
              <Label htmlFor="ot-to" className="text-[10px] uppercase tracking-wider">
                To
              </Label>
              <Input
                id="ot-to"
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

        {/* Filters */}
        <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
          {/* flex items-center, not just relative: this is a grid item, so
              it stretches to the row height set by the taller Select next
              to it. The h-9 Input would otherwise sit at the top of that
              box while the icon's top-1/2 centred against the box, leaving
              the two misaligned. Centring the input makes both agree. */}
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search employee or project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <p className="text-[11px] text-muted-foreground">
          Showing {filtered.length} of {rows.length} submissions
        </p>

        {filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? "No OT submissions in this date range."
              : "No submissions match the current filters."}
          </p>
        ) : (
          <ScrollArea className="max-h-[520px] overflow-auto rounded-md border border-border/40">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="bg-card py-2 pl-3 pr-3 font-semibold">Employee</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Date</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Time range</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Duration</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Reviewed by</th>
                  <th className="bg-card py-2 pr-3 font-semibold">Status</th>
                  <th className="bg-card py-2 pr-3 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <React.Fragment key={row.id}>
                    <tr
                      className="border-b border-border/30 text-foreground last:border-0"
                    >
                      <td className="py-2.5 pl-3 pr-3">
                        <p className="font-medium">{row.employeeName}</p>
                        {row.project ? (
                          <p className="text-[11px] text-muted-foreground">{row.project}</p>
                        ) : null}
                        {row.detail ? (
                          <p className="mt-0.5 max-w-[200px] truncate text-[11px] text-muted-foreground">
                            {row.detail}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3 text-xs tabular-nums">
                        {fmtDate(row.date)}
                      </td>
                      <td className="py-2.5 pr-3 text-xs tabular-nums" suppressHydrationWarning>
                        {row.otStartAt && row.otEndAt ? (
                          <span suppressHydrationWarning>
                            {fmtTime(row.otStartAt)} – {fmtTime(row.otEndAt)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs font-medium tabular-nums">
                        {row.otStartAt && row.otEndAt
                          ? fmtDuration(row.otStartAt, row.otEndAt)
                          : "—"}
                      </td>
                      <td className="py-2.5 pr-3 text-xs">
                        {row.reviewerName ? (
                          <div>
                            <p>{row.reviewerName}</p>
                            {row.reviewedAt ? (
                              <p className="text-[11px] text-muted-foreground" suppressHydrationWarning>
                                {fmtDate(row.reviewedAt)}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge variant={APPROVAL_VARIANT[row.status] as never}>
                          {approvalStatusMeta[row.status].label}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-3">
                        {row.attachments.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            title="View evidence"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            <span>{row.attachments.length}</span>
                            {expandedId === row.id
                              ? <ChevronUp className="h-3 w-3" />
                              : <ChevronDown className="h-3 w-3" />
                            }
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {expandedId === row.id && row.attachments.length > 0 && (
                      <tr className="border-b border-border/30 bg-secondary/20">
                        <td colSpan={8} className="px-3 py-3">
                          <div className="flex gap-8">
                            {(["JUSTIFICATION", "EVIDENCE"] as const).map((kind) => {
                              const items = row.attachments.filter((a) => a.kind === kind)
                              return (
                                <div key={kind} className="space-y-1 min-w-0">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    {kind === "JUSTIFICATION" ? "Before (Justification)" : "After (Evidence)"}
                                  </p>
                                  {items.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">None uploaded.</p>
                                  ) : items.map((a) => (
                                    <a
                                      key={a.id}
                                      href={a.fileUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                                    >
                                      <FileText className="h-3.5 w-3.5 shrink-0" />
                                      <div className="min-w-0">
                                        <span className="max-w-[200px] truncate block">{a.fileName}</span>
                                        {a.uploadedAt ? (
                                          <span className="text-[10px] text-muted-foreground font-normal">
                                            {fmtUploadedAt(a.uploadedAt)}
                                          </span>
                                        ) : null}
                                      </div>
                                    </a>
                                  ))}
                                </div>
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
