"use client"

import { useMemo, useState, useTransition, type ReactNode } from "react"
import { Check, ChevronDown, ChevronUp, FileText, Minus, Pencil, Search } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card } from "@/components/attendance/ui/card"
import { DateTimeField } from "@/components/attendance/datetime-field"
import { Input } from "@/components/attendance/ui/input"
import { SelfieThumbnail } from "@/components/attendance/selfie-thumbnail"
import { CoordsLink } from "@/components/attendance/coords-link"
import { useToast } from "@/components/ui/toaster"
import type { ApprovalRequestView } from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

import { notifyBadgeRefresh } from "@/lib/badge-refresh"

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

function fmtDuration(startIso: string, endIso: string): string {
  const diffMin = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  )
  if (diffMin <= 0) return "—"
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
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

function AttachmentLink({ a }: { a: ApprovalRequestView["attachments"][number] }) {
  return (
    <a
      href={a.fileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-xs text-primary hover:underline"
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">
        <span className="truncate block">{a.fileName}</span>
        {a.uploadedAt ? (
          <span className="text-[10px] text-muted-foreground font-normal not-italic">
            {fmtUploadedAt(a.uploadedAt)}
          </span>
        ) : null}
      </div>
    </a>
  )
}

function OtAttachmentSplit({ attachments }: { attachments: ApprovalRequestView["attachments"] }) {
  const justification = attachments.filter((a) => a.kind === "JUSTIFICATION")
  const evidence = attachments.filter((a) => a.kind === "EVIDENCE")
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Before (Justification)
        </p>
        {justification.length === 0 ? (
          <p className="text-xs text-muted-foreground">None uploaded.</p>
        ) : (
          justification.map((a) => <AttachmentLink key={a.id} a={a} />)
        )}
      </div>
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          After (Evidence)
        </p>
        {evidence.length === 0 ? (
          <p className="text-xs text-muted-foreground">None uploaded.</p>
        ) : (
          evidence.map((a) => <AttachmentLink key={a.id} a={a} />)
        )}
      </div>
    </div>
  )
}

type Props = {
  items: ApprovalRequestView[]
  reviewedOt: ApprovalRequestView[]
}

function CheckBox({
  state,
  onClick,
  disabled,
  label,
}: {
  state: "checked" | "unchecked" | "indeterminate"
  onClick: () => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "indeterminate" ? "mixed" : state === "checked"}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors disabled:opacity-40",
        state === "unchecked"
          ? "border-border/70 bg-transparent hover:border-primary/60"
          : "border-primary bg-primary text-primary-foreground",
      )}
    >
      {state === "checked" ? (
        <Check className="h-3 w-3" />
      ) : state === "indeterminate" ? (
        <Minus className="h-3 w-3" />
      ) : null}
    </button>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-[72px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground">{children}</dd>
    </div>
  )
}

type EmployeeGroup = {
  employeeId: string
  employeeName: string
  date: string
  events: ApprovalRequestView[]
}

// ─── Attendance tab ───────────────────────────────────────────────────────────

function AttendanceList({ items }: { items: ApprovalRequestView[] }) {
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "7days">("all")
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [bulkPendingFor, setBulkPendingFor] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())

  function visibleIdsFor(group: EmployeeGroup): string[] {
    return group.events
      .filter((e) => !optimisticallyHidden.has(e.id))
      .map((e) => e.id)
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllInGroup(group: EmployeeGroup) {
    const ids = visibleIdsFor(group)
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  function clearGroupSelection(group: EmployeeGroup) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const e of group.events) next.delete(e.id)
      return next
    })
  }

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
    ids: string[],
  ) {
    if (ids.length === 0) return
    const groupKey = `${group.employeeId}:${group.date}`
    setBulkPendingFor(groupKey)
    setOptimisticallyHidden((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })

    startTransition(async () => {
      let ok = false
      let message = ""

      if (status === "APPROVED" && ids.some((id) => overrides[id])) {
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
      if (ok) notifyBadgeRefresh()
      toast({ title: message, variant: ok ? "success" : "error" })
    })
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    let exactDate: string | null = null
    let minDate: string | null = null
    if (dateFilter !== "all") {
      const pad = (n: number) => String(n).padStart(2, "0")
      const ymd = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const today = new Date()
      if (dateFilter === "today") {
        exactDate = ymd(today)
      } else {
        const start = new Date(today)
        start.setDate(start.getDate() - 6)
        minDate = ymd(start)
      }
    }
    const map = new Map<string, EmployeeGroup>()
    for (const item of items) {
      if (optimisticallyHidden.has(item.id)) continue
      if (q && !item.employeeName.toLowerCase().includes(q)) continue
      if (exactDate && item.date !== exactDate) continue
      if (minDate && item.date < minDate) continue
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
  }, [items, query, optimisticallyHidden, dateFilter])

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

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", "All"],
            ["today", "Today"],
            ["7days", "Last 7 days"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setDateFilter(key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              dateFilter === key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No pending requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {query ? "Try a different search." : "All caught up!"}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/60">
            {groups.map((group) => {
              const groupKey = `${group.employeeId}:${group.date}`
              const isExpanded = expandedGroups.has(groupKey)
              const isBusy = bulkPendingFor === groupKey
              const visibleIds = visibleIdsFor(group)
              const selectedIds = visibleIds.filter((id) => selected.has(id))
              const hasSelection = selectedIds.length > 0
              const groupState: "checked" | "unchecked" | "indeterminate" =
                selectedIds.length === 0
                  ? "unchecked"
                  : selectedIds.length === visibleIds.length
                    ? "checked"
                    : "indeterminate"
              const lateCount = group.events.filter(
                (e) => e.kind === "CLOCK_IN" && e.lateMinutes && e.lateMinutes > 0,
              ).length
              const offSite = group.events.some(
                (e) => parseApprovalDetail(e.detail).offSite,
              )

              return (
                <div key={groupKey}>
                  <div className="flex items-center gap-2 px-3">
                    {isExpanded ? (
                      <CheckBox
                        state={groupState}
                        disabled={isBusy}
                        onClick={() => toggleSelectAllInGroup(group)}
                        label={`Select all events for ${group.employeeName}`}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => toggleExpanded(groupKey)}
                      className="flex flex-1 items-center justify-between gap-3 py-3 pl-1 text-left transition-colors hover:bg-surface-low/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">
                          {group.employeeName}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {group.date} &middot; {group.events.length} event
                          {group.events.length !== 1 ? "s" : ""} pending
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {lateCount > 0 ? (
                          <Badge variant="late" className="text-[10px]">
                            {lateCount} late
                          </Badge>
                        ) : null}
                        {offSite ? (
                          <Badge variant="overtime" className="text-[10px]">
                            Off-site
                          </Badge>
                        ) : null}
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </button>
                  </div>

                  {isExpanded ? (
                    <>
                      <div className="divide-y divide-border/40 border-t border-border/60">
                      {group.events.map((r) => {
                        const parsed = parseApprovalDetail(r.detail)
                        const canAdjust =
                          r.kind === "CLOCK_IN" || r.kind === "CLOCK_OUT"
                        const isAdjusting = overrides[r.id] !== undefined
                        const isLate =
                          r.kind === "CLOCK_IN" && (r.lateMinutes ?? 0) > 0
                        const earlyMin =
                          r.kind === "CLOCK_IN" && !r.lateMinutes
                            ? parseEarlyMinutes(r.title)
                            : null
                        const stepFlag = r.totalSteps > 1 && r.currentStep

                        return (
                          <div key={r.id} className="flex gap-3 px-4 py-3">
                            <div className="pt-0.5">
                              <CheckBox
                                state={selected.has(r.id) ? "checked" : "unchecked"}
                                disabled={isBusy}
                                onClick={() => toggleSelect(r.id)}
                                label="Select this event"
                              />
                            </div>
                            <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-sm font-semibold text-foreground">
                                {CLOCK_LABEL[r.kind] ?? "Clock"}
                              </span>
                              {canAdjust ? (
                                <button
                                  type="button"
                                  onClick={() => toggleOverride(r.id, r.eventAt)}
                                  disabled={isBusy}
                                  title={isAdjusting ? "Cancel time adjustment" : "Adjust time"}
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

                            <div className="mt-1.5 flex flex-row-reverse items-start gap-3">
                              {r.selfieAttendanceRecordId ? (
                                <SelfieThumbnail
                                  recordId={r.selfieAttendanceRecordId}
                                  phase={r.kind === "CLOCK_OUT" ? "clock-out" : "clock-in"}
                                  size={72}
                                  className="rounded-lg"
                                />
                              ) : null}
                              <div className="min-w-0 flex-1">
                                <dl className="space-y-1 text-xs">
                                  <DetailRow label="Time">
                                    {fmtTime(r.eventAt)}
                                  </DetailRow>
                                  {isLate ? (
                                    <DetailRow label="Late">
                                      <span className="font-semibold text-amber-700 dark:text-amber-400">
                                        Yes · {r.lateMinutes} min
                                      </span>
                                    </DetailRow>
                                  ) : null}
                                  {earlyMin ? (
                                    <DetailRow label="Early">
                                      {earlyMin} min
                                    </DetailRow>
                                  ) : null}
                                  <DetailRow label="Off-site">
                                    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                      {parsed.offSite ? (
                                        <span className="font-semibold text-destructive">Yes</span>
                                      ) : (
                                        "No"
                                      )}
                                      {r.latitude != null && r.longitude != null ? (
                                        <CoordsLink
                                          lat={r.latitude}
                                          lng={r.longitude}
                                          showCoords={false}
                                          label="Open in map"
                                        />
                                      ) : null}
                                    </span>
                                  </DetailRow>
                                  {r.project ? (
                                    <DetailRow label="Project">{r.project}</DetailRow>
                                  ) : null}
                                  {r.location ? (
                                    <DetailRow label="Location">{r.location}</DetailRow>
                                  ) : null}
                                  {stepFlag ? (
                                    <DetailRow label="Step">
                                      {r.currentStep} of {r.totalSteps}
                                    </DetailRow>
                                  ) : null}
                                  {parsed.remark ? (
                                    <DetailRow label="Remark">{parsed.remark}</DetailRow>
                                  ) : null}
                                </dl>

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

                            {isAdjusting ? (
                              <div className="mt-2 space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/80">
                                  Adjusted{" "}
                                  {r.kind === "CLOCK_IN" ? "clock-in" : "clock-out"} time
                                </p>
                                <DateTimeField
                                  value={overrides[r.id] ?? ""}
                                  onChange={(v) => setOverrideValue(r.id, v)}
                                  compact
                                />
                                <p className="text-[10px] text-muted-foreground">
                                  This override is applied when you click &ldquo;Approve all&rdquo; below.
                                </p>
                              </div>
                            ) : null}
                            </div>
                          </div>
                        )
                      })}
                      </div>

                      <div className="flex items-center gap-3 border-t border-border/60 px-4 py-3">
                        {hasSelection ? (
                          <>
                            <span className="text-xs text-muted-foreground">
                              {selectedIds.length} of {visibleIds.length} selected
                            </span>
                            <button
                              type="button"
                              onClick={() => clearGroupSelection(group)}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              Clear
                            </button>
                          </>
                        ) : null}
                        <div className="ml-auto flex gap-2">
                          <Button
                            size="sm"
                            disabled={isBusy}
                            onClick={() =>
                              bulkAction(group, "APPROVED", hasSelection ? selectedIds : visibleIds)
                            }
                          >
                            {isBusy
                              ? "Saving…"
                              : hasSelection
                                ? `Approve selected (${selectedIds.length})`
                                : `Approve all (${visibleIds.length})`}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() =>
                              bulkAction(group, "REJECTED", hasSelection ? selectedIds : visibleIds)
                            }
                          >
                            {hasSelection
                              ? `Reject selected (${selectedIds.length})`
                              : `Reject all (${visibleIds.length})`}
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── OT tab ───────────────────────────────────────────────────────────────────

function OtCard({ item }: { item: ApprovalRequestView }) {
  const { toast } = useToast()
  const [hidden, setHidden] = useState(false)
  const [isPending, startTransition] = useTransition()

  function submit(status: "APPROVED" | "REJECTED") {
    startTransition(async () => {
      const fd = new FormData()
      fd.set("approvalId", item.id)
      fd.set("status", status)
      const result = await reviewApprovalAction({}, fd)
      if (result.error) {
        toast({ title: result.error, variant: "error" })
      } else {
        setHidden(true)
        notifyBadgeRefresh()
        toast({
          title: status === "APPROVED" ? "OT approved." : "OT rejected.",
          variant: status === "APPROVED" ? "success" : "error",
        })
      }
    })
  }

  if (hidden) return null

  const stepFlag = item.totalSteps > 1 && item.currentStep
  const hasPeriod = item.otStartAt && item.otEndAt

  return (
    <div className="space-y-3 px-4 py-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{item.employeeName}</p>
        <p className="text-[11px] text-muted-foreground">{item.date}</p>
      </div>

      <dl className="space-y-1 text-xs">
        {hasPeriod ? (
          <>
            <DetailRow label="Period">
              {fmtTime(item.otStartAt)} – {fmtTime(item.otEndAt)}
            </DetailRow>
            <DetailRow label="Duration">
              {fmtDuration(item.otStartAt!, item.otEndAt!)}
            </DetailRow>
          </>
        ) : null}
        {item.otPayoutMethod ? (
          <DetailRow label="Payout">
            {item.otPayoutMethod === "TIME_BANK" ? "Time bank" : "Cash"}
          </DetailRow>
        ) : null}
        {item.project ? (
          <DetailRow label="Project">{item.project}</DetailRow>
        ) : null}
        {stepFlag ? (
          <DetailRow label="Step">
            {item.currentStep} of {item.totalSteps}
          </DetailRow>
        ) : null}
        {item.detail ? (
          <DetailRow label="Reason">{item.detail}</DetailRow>
        ) : null}
      </dl>

      {item.chainHistory && item.chainHistory.length > 0 ? (
        <div className="space-y-0.5 rounded-md border border-border/60 bg-secondary/20 px-2 py-1.5">
          {item.chainHistory.map((h) => (
            <p key={`${h.step}-${h.approverId}`} className="text-[10px] text-muted-foreground">
              <span className="font-semibold text-foreground">Step {h.step}</span>{" "}
              {h.status === "APPROVED" ? "approved" : "rejected"} by{" "}
              <span className="font-semibold">{h.approverName}</span>
            </p>
          ))}
        </div>
      ) : null}

      <OtAttachmentSplit attachments={item.attachments} />

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          disabled={isPending}
          onClick={() => submit("APPROVED")}
        >
          {isPending ? "Saving…" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => submit("REJECTED")}
        >
          Reject
        </Button>
      </div>
    </div>
  )
}

function OtReviewedCard({ item }: { item: ApprovalRequestView }) {
  const isApproved = item.status === "APPROVED"
  return (
    <div className="space-y-2 px-4 py-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{item.employeeName}</p>
          <p className="text-[11px] text-muted-foreground">{item.date}</p>
        </div>
        <Badge variant={isApproved ? "approved" : "rejected"}>
          {isApproved ? "Approved" : "Rejected"}
        </Badge>
      </div>

      <dl className="space-y-1 text-xs">
        {item.otStartAt && item.otEndAt ? (
          <>
            <DetailRow label="Period">
              {fmtTime(item.otStartAt)} – {fmtTime(item.otEndAt)}
            </DetailRow>
            <DetailRow label="Duration">
              {fmtDuration(item.otStartAt, item.otEndAt)}
            </DetailRow>
          </>
        ) : null}
        {item.project ? (
          <DetailRow label="Project">{item.project}</DetailRow>
        ) : null}
        {item.detail ? (
          <DetailRow label="Reason">{item.detail}</DetailRow>
        ) : null}
        {item.reviewNotes ? (
          <DetailRow label="Notes">{item.reviewNotes}</DetailRow>
        ) : null}
      </dl>

      <OtAttachmentSplit attachments={item.attachments} />
    </div>
  )
}

function OtList({ items, reviewedOt }: { items: ApprovalRequestView[]; reviewedOt: ApprovalRequestView[] }) {
  const [otTab, setOtTab] = useState<"pending" | "reviewed">("pending")
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const source = otTab === "pending" ? items : reviewedOt
    if (!q) return source
    return source.filter((i) => i.employeeName.toLowerCase().includes(q))
  }, [items, reviewedOt, otTab, query])

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-border/60 bg-card p-1 w-fit">
        {(["pending", "reviewed"] as const).map((t) => {
          const count = t === "pending" ? items.length : reviewedOt.length
          const active = otTab === t
          return (
            <button
              key={t}
              type="button"
              onClick={() => { setOtTab(t); setQuery("") }}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors capitalize",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
              {count > 0 ? (
                <span className={cn(
                  "flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold",
                  active
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}>
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
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

      {filtered.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">
            {otTab === "pending" ? "No pending OT requests" : "No reviewed OT records"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {query ? "Try a different search." : otTab === "pending" ? "All caught up!" : "Reviewed OT will appear here."}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/60">
            {filtered.map((item) =>
              otTab === "pending"
                ? <OtCard key={item.id} item={item} />
                : <OtReviewedCard key={item.id} item={item} />
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Root component with tab switcher ────────────────────────────────────────

export function ApprovalsList({ items, reviewedOt }: Props) {
  const [tab, setTab] = useState<"attendance" | "overtime">("attendance")

  const attendanceItems = items.filter((i) => i.kind !== "OT")
  const otItems = items.filter((i) => i.kind === "OT")

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-border/60 bg-card p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab("attendance")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "attendance"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Attendance
          {attendanceItems.length > 0 ? (
            <span className={cn(
              "flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold",
              tab === "attendance"
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}>
              {attendanceItems.length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => setTab("overtime")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "overtime"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Overtime
          {otItems.length > 0 ? (
            <span className={cn(
              "flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold",
              tab === "overtime"
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}>
              {otItems.length}
            </span>
          ) : null}
        </button>
      </div>

      {tab === "attendance" ? (
        <AttendanceList items={attendanceItems} />
      ) : (
        <OtList items={otItems} reviewedOt={reviewedOt} />
      )}
    </div>
  )
}
