"use client"

import { useMemo, useState, useTransition } from "react"
import { Search } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import type { ApprovalRequestView } from "@/modules/attendance/domain/models"
import { otSubtypeMeta } from "@/modules/attendance/domain/metadata"
import { cn } from "@/lib/utils"

import { reviewApprovalAction } from "./actions"

const CLOCK_LABEL: Record<string, string> = {
  CLOCK_IN: "Clock in",
  CLOCK_OUT: "Clock out",
  BREAK: "Break check",
}

type Filter = "ALL" | "OT" | "CLOCK"

type Props = {
  items: ApprovalRequestView[]
}

export function ApprovalsList({ items }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL")
  const [query, setQuery] = useState("")
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<Set<string>>(new Set())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  function review(id: string, status: "APPROVED" | "REJECTED") {
    setPendingId(id)
    setOptimisticallyHidden((prev) => new Set(prev).add(id))
    const formData = new FormData()
    formData.set("approvalId", id)
    formData.set("status", status)
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
            <Card key={r.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {r.kind === "OT" ? (
                        <Badge variant="overtime">
                          {r.otSubtype ? otSubtypeMeta[r.otSubtype].label : "OT"}
                        </Badge>
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
                    </div>
                    <p className="mt-2 text-sm font-bold text-foreground">{r.employeeName}</p>
                    <p className="mt-0.5 text-sm font-semibold text-foreground">{r.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                    {r.project ? (
                      <p className="mt-0.5 text-[11px] font-semibold text-primary">
                        🛠 {r.project}
                      </p>
                    ) : null}
                    {r.location ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">📍 {r.location}</p>
                    ) : null}
                  </div>
                </div>
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
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
