"use client"

import { useMemo, useState, useTransition } from "react"
import { CheckSquare, Search, Square } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { DateTimeField } from "@/components/attendance/datetime-field"
import { Input } from "@/components/attendance/ui/input"
import { SelfieThumbnail } from "@/components/attendance/selfie-thumbnail"
import { useToast } from "@/components/ui/toaster"
import type { ApprovalRequestView } from "@/modules/attendance/domain/models"
import { otSubtypeMeta } from "@/modules/attendance/domain/metadata"
import { cn } from "@/lib/utils"

import { bulkReviewApprovalsAction, reviewApprovalAction } from "./actions"

const CLOCK_LABEL: Record<string, string> = {
  CLOCK_IN: "Clock in",
  CLOCK_OUT: "Clock out",
  BREAK: "Break check",
}

const OFF_SITE_PREFIX = "⚠ OFF-SITE — "

function toLocalDatetimeInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function parseEarlyMinutes(title: string): number | null {
  const match = /(\d+)m early/i.exec(title)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseApprovalDetail(detail: string): {
  offSite: boolean
  base: string
  remark: string | null
} {
  const offSite = detail.startsWith(OFF_SITE_PREFIX)
  const body = offSite ? detail.slice(OFF_SITE_PREFIX.length) : detail
  const remarkIdx = body.indexOf("\nRemark: ")
  if (remarkIdx === -1) {
    return { offSite, base: body, remark: null }
  }
  return {
    offSite,
    base: body.slice(0, remarkIdx),
    remark: body.slice(remarkIdx + "\nRemark: ".length),
  }
}

type Filter = "ALL" | "OT" | "CLOCK"

type Props = {
  items: ApprovalRequestView[]
}

export function ApprovalsList({ items }: Props) {
  const { toast } = useToast()
  const [filter, setFilter] = useState<Filter>("ALL")
  const [query, setQuery] = useState("")
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<Set<string>>(new Set())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [bulkPending, startBulkTransition] = useTransition()
  const [, startTransition] = useTransition()
  // Per-row override editor state: maps approvalId → local datetime string
  // (or "" when the editor is open but not yet edited). `undefined` means
  // the editor isn't expanded for that row.
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  // Multi-select for bulk approve/reject. Selections are independent of
  // the filter so the bar shows the real count even after switching
  // filters; non-visible selections are simply preserved until cleared.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  function toggleOneSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleOverride(id: string, initial: string | null) {
    setOverrides((prev) => {
      if (prev[id] !== undefined) {
        const next = { ...prev }
        delete next[id]
        return next
      }
      return { ...prev, [id]: toLocalDatetimeInput(initial) }
    })
  }

  function setOverrideValue(id: string, value: string) {
    setOverrides((prev) => ({ ...prev, [id]: value }))
  }

  function review(id: string, status: "APPROVED" | "REJECTED") {
    setPendingId(id)
    setOptimisticallyHidden((prev) => new Set(prev).add(id))
    const formData = new FormData()
    formData.set("approvalId", id)
    formData.set("status", status)
    const override = overrides[id]
    if (status === "APPROVED" && override) {
      formData.set("overrideEventAt", override)
    }
    startTransition(async () => {
      const result = await reviewApprovalAction({}, formData)
      if (result.error) {
        setOptimisticallyHidden((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
      setPendingId(null)
    })
  }

  function bulkReview(status: "APPROVED" | "REJECTED") {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    // Optimistically hide so the rows disappear immediately. Restore on
    // failure (the action returns succeeded/failed counts but doesn't
    // tell us WHICH failed, so on partial failure we restore them all
    // and revalidation will re-show whatever's still pending).
    setOptimisticallyHidden((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    const formData = new FormData()
    formData.set("approvalIds", JSON.stringify(ids))
    formData.set("status", status)
    startBulkTransition(async () => {
      const result = await bulkReviewApprovalsAction(
        { ok: false, message: "", succeeded: 0, failed: 0 },
        formData,
      )
      if (!result.ok) {
        // Restore any ids that may not have applied — server revalidation
        // will refresh the underlying `items` so this is just so the UI
        // doesn't look prematurely empty when something failed.
        setOptimisticallyHidden((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
      }
      setSelectedIds(new Set())
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((r) => {
      if (optimisticallyHidden.has(r.id)) return false
      const isOT = r.kind === "OT"
      if (filter === "OT" && !isOT) return false
      if (filter === "CLOCK" && isOT) return false
      if (q && !r.employeeName.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, filter, query, optimisticallyHidden])

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {filtered.length} of {items.length} pending
        </p>
        <h2 className="sr-only">Approvals queue</h2>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search employee name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-1.5">
          {(["ALL", "OT", "CLOCK"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                filter === f
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "ALL" ? "All" : f === "OT" ? "OT" : "Attendance"}
            </button>
          ))}
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-surface-low/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => {
              const visibleIds = filtered.map((r) => r.id)
              const allVisibleSelected = visibleIds.every((id) =>
                selectedIds.has(id),
              )
              setSelectedIds((prev) => {
                const next = new Set(prev)
                if (allVisibleSelected) {
                  for (const id of visibleIds) next.delete(id)
                } else {
                  for (const id of visibleIds) next.add(id)
                }
                return next
              })
            }}
            disabled={bulkPending}
            className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {filtered.every((r) => selectedIds.has(r.id)) ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {filtered.every((r) => selectedIds.has(r.id))
              ? "Deselect all"
              : "Select all"}
            {selectedIds.size > 0 ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                {selectedIds.size} selected
              </span>
            ) : null}
          </button>
          {selectedIds.size > 0 ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={bulkPending}
                onClick={() => bulkReview("APPROVED")}
              >
                {bulkPending
                  ? "Saving…"
                  : `Approve ${selectedIds.size}`}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkPending}
                onClick={() => bulkReview("REJECTED")}
              >
                Reject {selectedIds.size}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={bulkPending}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No matching requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try a different filter or clear the search.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <Card
              key={r.id}
              className={cn(
                selectedIds.has(r.id) && "border-primary/60 bg-primary/5",
              )}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleOneSelected(r.id)}
                    disabled={bulkPending}
                    aria-label={
                      selectedIds.has(r.id)
                        ? "Deselect for bulk action"
                        : "Select for bulk action"
                    }
                    className="-ml-1 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {selectedIds.has(r.id) ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  {r.kind === "OT" ? (
                    <>
                      <Badge variant="overtime">
                        {r.otSubtype ? otSubtypeMeta[r.otSubtype].label : "OT"}
                      </Badge>
                      {r.otPayoutMethod ? (
                        <Badge variant="outline" className="font-semibold">
                          {r.otPayoutMethod === "TIME_BANK" ? "Time bank" : "Cash"}
                        </Badge>
                      ) : null}
                    </>
                  ) : (
                    <Badge
                      variant={
                        r.kind === "CLOCK_IN"
                          ? "clocked-in"
                          : r.kind === "CLOCK_OUT"
                            ? "clocked-out"
                            : "pending"
                      }
                    >
                      {CLOCK_LABEL[r.kind] ?? "Clock"}
                    </Badge>
                  )}
                  <span className="text-xs font-semibold text-muted-foreground">
                    {r.date}
                  </span>
                  {r.kind === "CLOCK_IN" && r.lateMinutes && r.lateMinutes > 0 ? (
                    <Badge variant="late" className="font-bold">
                      ⚠ LATE · {r.lateMinutes}m
                    </Badge>
                  ) : null}
                  {r.kind === "CLOCK_IN" && !r.lateMinutes ? (() => {
                    const early = parseEarlyMinutes(r.title)
                    return early ? (
                      <Badge variant="on-time" className="font-bold">
                        EARLY · {early}m
                      </Badge>
                    ) : null
                  })() : null}
                  {r.totalSteps > 1 && r.currentStep ? (
                    <Badge variant="pending" className="font-semibold">
                      Step {r.currentStep} of {r.totalSteps}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-2 flex items-start gap-3">
                  {r.selfieAttendanceRecordId ? (
                    <SelfieThumbnail
                      recordId={r.selfieAttendanceRecordId}
                      size={100}
                      className="rounded-lg"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-foreground">{r.employeeName}</p>
                    <p className="mt-0.5 text-sm font-semibold text-foreground">{r.title}</p>
                    {(() => {
                      const parsed = parseApprovalDetail(r.detail)
                      return (
                        <>
                          {parsed.offSite ? (
                            <Badge variant="overtime" className="mt-1">
                              ⚠ Off-site
                            </Badge>
                          ) : null}
                          <p className="mt-1 text-xs text-muted-foreground">{parsed.base}</p>
                          {parsed.remark ? (
                            <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                              <span className="font-semibold">Remark:</span> {parsed.remark}
                            </p>
                          ) : null}
                        </>
                      )
                    })()}
                    {r.project ? (
                      <p className="mt-0.5 text-[11px] font-semibold text-primary">
                        🛠 {r.project}
                      </p>
                    ) : null}
                    {r.location ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">📍 {r.location}</p>
                    ) : null}
                    {r.chainHistory && r.chainHistory.length > 0 ? (
                      <div className="mt-2 space-y-0.5 rounded-md border border-border/60 bg-secondary/20 px-2 py-1.5">
                        {r.chainHistory.map((h) => (
                          <p key={`${h.step}-${h.approverId}`} className="text-[10px] text-muted-foreground">
                            <span className="font-semibold text-foreground">
                              Step {h.step}
                            </span>{" "}
                            {h.status === "APPROVED" ? "approved" : "rejected"} by{" "}
                            <span className="font-semibold">{h.approverName}</span>{" "}
                            at{" "}
                            {new Date(h.reviewedAt).toLocaleTimeString("en-US", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                {(r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT") &&
                overrides[r.id] !== undefined ? (
                  <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-secondary/20 px-3 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Adjusted time
                    </p>
                    <DateTimeField
                      value={overrides[r.id] ?? ""}
                      onChange={(v) => setOverrideValue(r.id, v)}
                      compact
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Approving will set the record&apos;s{" "}
                      {r.kind === "CLOCK_IN" ? "clock-in" : "clock-out"} to this
                      value instead of the submitted timestamp.
                    </p>
                  </div>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={pendingId === r.id}
                    onClick={() => review(r.id, "APPROVED")}
                  >
                    {pendingId === r.id ? "Saving…" : "Approve"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    disabled={pendingId === r.id}
                    onClick={() => review(r.id, "REJECTED")}
                  >
                    Reject
                  </Button>
                  {r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs"
                      disabled={pendingId === r.id}
                      onClick={() => toggleOverride(r.id, r.eventAt)}
                    >
                      {overrides[r.id] !== undefined ? "Cancel adjust" : "Adjust time"}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
