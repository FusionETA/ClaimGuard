"use client"

import { useMemo, useState, useTransition } from "react"
import { ChevronDown, ChevronUp, Pencil, Search } from "lucide-react"

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
  // Which employee:date groups are expanded (collapsed by default)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [bulkPendingFor, setBulkPendingFor] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  // Per-row time override: maps approvalId → local datetime string.
  // `undefined` means the editor isn't open for that row.
  const [overrides, setOverrides] = useState<Record<string, string>>({})

  function toggleExpanded(groupKey: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
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

  function bulkAction(
    group: EmployeeGroup,
    status: "APPROVED" | "REJECTED",
  ) {
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

    startTransition(async () => {
      let ok = false
      let message = ""

      if (status === "APPROVED" && ids.some((id) => overrides[id])) {
        // At least one row has a time override — call reviewApprovalAction
        // individually so each override is applied correctly.
        let failed = 0
        for (const id of ids) {
          const fd = new FormData()
          fd.set("approvalId", id)
          fd.set("status", "APPROVED")
          if (overrides[id]) fd.set("overrideEventAt", overrides[id])
          const result = await reviewApprovalAction({}, fd)
          if (result.error) failed++
        }
        ok = failed === 0
        message = ok
          ? "All events approved."
          : `${failed} event(s) could not be approved.`
      } else {
        const fd = new FormData()
        fd.set("approvalIds", JSON.stringify(ids))
        fd.set("status", status)
        const result = await bulkReviewApprovalsAction(
          { ok: false, message: "", succeeded: 0, failed: 0 },
          fd,
        )
        ok = result.ok
        message = result.message
      }

      if (!ok) {
        setOptimisticallyHidden((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
      }
      setBulkPendingFor(null)
      toast({ title: message, variant: ok ? "success" : "error" })
    })
  }

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
    for (const group of map.values()) {
      group.events.sort((a, b) => {
        const ta = a.eventAt ? Date.parse(a.eventAt) : 0
        const tb = b.eventAt ? Date.parse(b.eventAt) : 0
        return ta - tb
      })
    }
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
        <div className="space-y-3">
          {groups.map((group) => {
            const groupKey = `${group.employeeId}:${group.date}`
            const isExpanded = expandedGroups.has(groupKey)
            const isBusy = bulkPendingFor === groupKey

            return (
              <Card key={groupKey} className="overflow-hidden">
                {/* Clickable header — toggles expand */}
                <button
                  type="button"
                  onClick={() => toggleExpanded(groupKey)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-low/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <div>
                    <p className="text-sm font-bold text-foreground">
                      {group.employeeName}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {group.date} &middot; {group.events.length} event
                      {group.events.length !== 1 ? "s" : ""} pending
                    </p>
                  </div>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </button>

                {isExpanded ? (
                  <>
                    {/* Event rows */}
                    <CardContent className="divide-y divide-border/40 border-t border-border/60 p-0">
                      {group.events.map((r) => {
                        const parsed = parseApprovalDetail(r.detail)
                        const canAdjust =
                          r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT"
                        const isAdjusting = overrides[r.id] !== undefined

                        return (
                          <div key={r.id} className="px-4 py-3">
                            {/* Event header row */}
                            <div className="flex items-center gap-2">
                              <div className="flex flex-1 flex-wrap items-center gap-2">
                                {r.kind === "OT" ? (
                                  <>
                                    <Badge variant="overtime">
                                      {r.otSubtype
                                        ? otSubtypeMeta[r.otSubtype].label
                                        : "OT"}
                                    </Badge>
                                    {r.otPayoutMethod ? (
                                      <Badge
                                        variant="outline"
                                        className="font-semibold"
                                      >
                                        {r.otPayoutMethod === "TIME_BANK"
                                          ? "Time bank"
                                          : "Cash"}
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
                                {r.kind === "CLOCK_IN" &&
                                r.lateMinutes &&
                                r.lateMinutes > 0 ? (
                                  <Badge variant="late" className="font-bold">
                                    ⚠ LATE · {r.lateMinutes}m
                                  </Badge>
                                ) : null}
                                {r.kind === "CLOCK_IN" && !r.lateMinutes
                                  ? (() => {
                                      const early = parseEarlyMinutes(r.title)
                                      return early ? (
                                        <Badge
                                          variant="on-time"
                                          className="font-bold"
                                        >
                                          EARLY · {early}m
                                        </Badge>
                                      ) : null
                                    })()
                                  : null}
                                {r.totalSteps > 1 && r.currentStep ? (
                                  <Badge
                                    variant="pending"
                                    className="font-semibold"
                                  >
                                    Step {r.currentStep}/{r.totalSteps}
                                  </Badge>
                                ) : null}
                              </div>

                              {/* Pencil — time-adjust toggle (CLOCK_IN / CLOCK_OUT only) */}
                              {canAdjust ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    toggleOverride(r.id, r.eventAt)
                                  }
                                  disabled={isBusy}
                                  title={
                                    isAdjusting
                                      ? "Cancel time adjustment"
                                      : "Adjust time"
                                  }
                                  className={cn(
                                    "ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40",
                                    isAdjusting
                                      ? "bg-primary/10 text-primary"
                                      : "text-muted-foreground hover:bg-surface-low hover:text-foreground",
                                  )}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </div>

                            {/* Event body */}
                            <div className="mt-1.5 flex items-start gap-3">
                              {r.selfieAttendanceRecordId ? (
                                <SelfieThumbnail
                                  recordId={r.selfieAttendanceRecordId}
                                  phase={r.kind === "CLOCK_OUT" ? "clock-out" : "clock-in"}
                                  size={72}
                                  className="rounded-lg"
                                />
                              ) : null}
                              <div className="min-w-0 flex-1">
                                {parsed.offSite ? (
                                  <Badge variant="overtime" className="mb-1">
                                    ⚠ Off-site
                                  </Badge>
                                ) : null}
                                <p className="text-xs text-muted-foreground">
                                  {parsed.base}
                                </p>
                                {parsed.remark ? (
                                  <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                                    <span className="font-semibold">
                                      Remark:
                                    </span>{" "}
                                    {parsed.remark}
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
                                        {h.status === "APPROVED"
                                          ? "approved"
                                          : "rejected"}{" "}
                                        by{" "}
                                        <span className="font-semibold">
                                          {h.approverName}
                                        </span>{" "}
                                        at{" "}
                                        {new Date(
                                          h.reviewedAt,
                                        ).toLocaleTimeString("en-US", {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        })}
                                      </p>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            {/* Inline time-adjust field */}
                            {isAdjusting ? (
                              <div className="mt-2 space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/80">
                                  Adjusted{" "}
                                  {r.kind === "CLOCK_IN"
                                    ? "clock-in"
                                    : "clock-out"}{" "}
                                  time
                                </p>
                                <DateTimeField
                                  value={overrides[r.id] ?? ""}
                                  onChange={(v) => setOverrideValue(r.id, v)}
                                  compact
                                />
                                <p className="text-[10px] text-muted-foreground">
                                  This override is applied when you click
                                  &ldquo;Approve all&rdquo; below.
                                </p>
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </CardContent>

                    {/* Card footer — Approve all / Reject all */}
                    <div className="flex gap-2 border-t border-border/60 px-4 py-3">
                      <Button
                        size="sm"
                        className="flex-1"
                        disabled={isBusy}
                        onClick={() => bulkAction(group, "APPROVED")}
                      >
                        {isBusy ? "Saving…" : "Approve all"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={isBusy}
                        onClick={() => bulkAction(group, "REJECTED")}
                      >
                        Reject all
                      </Button>
                    </div>
                  </>
                ) : null}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
