"use client"

import { useMemo, useState, useTransition } from "react"
import { Search } from "lucide-react"

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

function fmtTime(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

type Props = {
  items: ApprovalRequestView[]
}

type EmployeeGroup = {
  employeeId: string
  employeeName: string
  date: string
  events: ApprovalRequestView[]
}

export function ApprovalsList({ items }: Props) {
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<Set<string>>(new Set())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [bulkPendingFor, setBulkPendingFor] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [, startBulkTransition] = useTransition()
  // Per-row override editor state: maps approvalId → local datetime string.
  // `undefined` means the editor isn't expanded for that row.
  const [overrides, setOverrides] = useState<Record<string, string>>({})

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

  function approveAllForEmployee(group: EmployeeGroup) {
    const ids = group.events
      .filter((e) => !optimisticallyHidden.has(e.id))
      .map((e) => e.id)
    if (ids.length === 0) return
    const groupKey = `${group.employeeId}:${group.date}`
    setBulkPendingFor(groupKey)
    setOptimisticallyHidden((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    const formData = new FormData()
    formData.set("approvalIds", JSON.stringify(ids))
    formData.set("status", "APPROVED")
    startBulkTransition(async () => {
      const result = await bulkReviewApprovalsAction(
        { ok: false, message: "", succeeded: 0, failed: 0 },
        formData,
      )
      if (!result.ok) {
        setOptimisticallyHidden((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
      }
      setBulkPendingFor(null)
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
    })
  }

  // Group items by (employeeId, date) — each group = one employee's events
  // for a given day, sorted chronologically.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<string, EmployeeGroup>()
    for (const item of items) {
      if (optimisticallyHidden.has(item.id)) continue
      if (q && !item.employeeName.toLowerCase().includes(q)) continue
      const key = `${item.employeeId}:${item.date}`
      const existing = map.get(key)
      if (existing) {
        existing.events.push(item)
      } else {
        map.set(key, {
          employeeId: item.employeeId,
          employeeName: item.employeeName,
          date: item.date,
          events: [item],
        })
      }
    }
    // Sort events within each group by eventAt ascending.
    for (const group of map.values()) {
      group.events.sort((a, b) => {
        const ta = a.eventAt ? Date.parse(a.eventAt) : 0
        const tb = b.eventAt ? Date.parse(b.eventAt) : 0
        return ta - tb
      })
    }
    // Sort groups by date desc, then employee name asc.
    return Array.from(map.values()).sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date)
      return a.employeeName.localeCompare(b.employeeName)
    })
  }, [items, query, optimisticallyHidden])

  const totalVisible = groups.reduce((acc, g) => acc + g.events.length, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {totalVisible} of {items.length} pending
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search employee name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {groups.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No pending requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {query ? "Try a different search." : "All caught up!"}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const groupKey = `${group.employeeId}:${group.date}`
            const isGroupBulkPending = bulkPendingFor === groupKey
            const pendingCount = group.events.length

            return (
              <Card key={groupKey} className="overflow-hidden">
                {/* Employee header */}
                <div className="flex items-center justify-between border-b border-border/60 bg-surface-low/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-bold text-foreground">{group.employeeName}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {group.date} &middot; {pendingCount} event{pendingCount !== 1 ? "s" : ""} pending
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={isGroupBulkPending || pendingCount === 0}
                    onClick={() => approveAllForEmployee(group)}
                  >
                    {isGroupBulkPending ? "Saving…" : "Approve all"}
                  </Button>
                </div>

                {/* Event rows */}
                <CardContent className="divide-y divide-border/40 p-0">
                  {group.events.map((r) => {
                    const parsed = parseApprovalDetail(r.detail)
                    return (
                      <div key={r.id} className="px-4 py-3">
                        {/* Event header row */}
                        <div className="flex flex-wrap items-center gap-2">
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
                          <span className="text-xs font-bold text-foreground">
                            {fmtTime(r.eventAt)}
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
                              Step {r.currentStep}/{r.totalSteps}
                            </Badge>
                          ) : null}
                        </div>

                        {/* Event body */}
                        <div className="mt-2 flex items-start gap-3">
                          {r.selfieAttendanceRecordId ? (
                            <SelfieThumbnail
                              recordId={r.selfieAttendanceRecordId}
                              size={80}
                              className="rounded-lg"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-foreground">{r.title}</p>
                            {parsed.offSite ? (
                              <Badge variant="overtime" className="mt-1">
                                ⚠ Off-site
                              </Badge>
                            ) : null}
                            <p className="mt-0.5 text-xs text-muted-foreground">{parsed.base}</p>
                            {parsed.remark ? (
                              <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                                <span className="font-semibold">Remark:</span> {parsed.remark}
                              </p>
                            ) : null}
                            {r.project ? (
                              <p className="mt-0.5 text-[11px] font-semibold text-primary">
                                🛠 {r.project}
                              </p>
                            ) : null}
                            {r.location ? (
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                📍 {r.location}
                              </p>
                            ) : null}
                            {r.chainHistory && r.chainHistory.length > 0 ? (
                              <div className="mt-2 space-y-0.5 rounded-md border border-border/60 bg-secondary/20 px-2 py-1.5">
                                {r.chainHistory.map((h) => (
                                  <p
                                    key={`${h.step}-${h.approverId}`}
                                    className="text-[10px] text-muted-foreground"
                                  >
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

                        {/* Per-event time adjust */}
                        {(r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT") &&
                        overrides[r.id] !== undefined ? (
                          <div className="mt-2 space-y-2 rounded-xl border border-border/60 bg-secondary/20 px-3 py-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Adjusted time
                            </p>
                            <DateTimeField
                              value={overrides[r.id] ?? ""}
                              onChange={(v) => setOverrideValue(r.id, v)}
                              compact
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Approving will set the{" "}
                              {r.kind === "CLOCK_IN" ? "clock-in" : "clock-out"} to this time.
                            </p>
                          </div>
                        ) : null}

                        {/* Per-event actions */}
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            className="flex-1"
                            disabled={pendingId === r.id || isGroupBulkPending}
                            onClick={() => review(r.id, "APPROVED")}
                          >
                            {pendingId === r.id ? "Saving…" : "Approve"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1"
                            disabled={pendingId === r.id || isGroupBulkPending}
                            onClick={() => review(r.id, "REJECTED")}
                          >
                            Reject
                          </Button>
                          {r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className={cn("text-xs", overrides[r.id] !== undefined && "text-primary")}
                              disabled={pendingId === r.id || isGroupBulkPending}
                              onClick={() => toggleOverride(r.id, r.eventAt)}
                            >
                              {overrides[r.id] !== undefined ? "Cancel adjust" : "Adjust time"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
