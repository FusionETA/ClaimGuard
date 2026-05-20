"use client"

import { useMemo, useState, useTransition } from "react"
import { Search } from "lucide-react"

import { decideLeaveAction } from "@/app/(employee)/employee/leave/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

type Application = {
  id: string
  employeeName: string
  leaveTypeCode: string
  leaveTypeName: string
  paid: boolean
  startDate: string
  endDate: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  totalDays: number
  reason: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  currentStep: number
  createdAt: string
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

export function LeaveApprovalsList({ items }: { items: Application[] }) {
  const [query, setQuery] = useState("")
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((a) => {
      if (hidden.has(a.id)) return false
      if (!q) return true
      return (
        a.employeeName.toLowerCase().includes(q) ||
        a.leaveTypeCode.toLowerCase().includes(q) ||
        a.leaveTypeName.toLowerCase().includes(q)
      )
    })
  }, [items, query, hidden])

  function hide(id: string) {
    setHidden((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }
  function unhide(id: string) {
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {filtered.length} of {items.length} pending
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by employee or leave type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No matching requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {items.length === 0
              ? "Nothing waiting on you right now."
              : "Try a different search."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => (
            <ApprovalCard
              key={a.id}
              app={a}
              onHide={() => hide(a.id)}
              onRestore={() => unhide(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ApprovalCard({
  app,
  onHide,
  onRestore,
}: {
  app: Application
  onHide: () => void
  onRestore: () => void
}) {
  const [notes, setNotes] = useState("")
  const [pending, startTransition] = useTransition()
  const [pendingDecision, setPendingDecision] = useState<"APPROVED" | "REJECTED" | null>(null)
  const [error, setError] = useState<string | null>(null)

  function act(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && notes.trim() === "") {
      setError("Please add a note explaining the rejection.")
      return
    }
    setError(null)
    setPendingDecision(decision)
    // Optimistically remove from queue so the supervisor can keep moving.
    onHide()
    startTransition(async () => {
      const res = await decideLeaveAction(app.id, decision, notes.trim() || undefined)
      if (!res.ok) {
        setError(res.error)
        setPendingDecision(null)
        onRestore()
      }
    })
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <Badge variant={app.paid ? "paid" : "outline"}>{app.leaveTypeCode}</Badge>
          {app.duration !== "FULL_DAY" && (
            <Badge variant="outline">
              {app.duration === "MORNING" ? "Half (AM)" : "Half (PM)"}
            </Badge>
          )}
          <span className="text-xs font-semibold text-muted-foreground">
            {fmtDate(app.startDate)}
            {app.startDate !== app.endDate && <> → {fmtDate(app.endDate)}</>}
          </span>
          {app.currentStep > 1 ? (
            <Badge variant="pending">Step {app.currentStep}</Badge>
          ) : null}
        </div>

        <div className="mt-3">
          <p className="text-sm font-bold text-foreground">{app.employeeName}</p>
          <p className="mt-0.5 text-sm text-foreground">
            {app.totalDays} day{app.totalDays === 1 ? "" : "s"} · {app.leaveTypeName}
            {!app.paid && (
              <span className="ml-1 text-xs text-muted-foreground">(unpaid)</span>
            )}
          </p>
          {app.reason ? (
            <p className="mt-1 rounded-md border border-border/60 bg-surface-low px-2 py-1 text-xs text-foreground">
              <span className="font-semibold">Reason:</span> {app.reason}
            </p>
          ) : null}
          {app.attachmentUrl ? (
            <p className="mt-1 text-xs">
              <span className="font-semibold">Attachment:</span>{" "}
              <a
                href={app.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {app.attachmentName ?? "View"}
              </a>
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-muted-foreground">
            Submitted {fmtDate(app.createdAt)}
          </p>
        </div>

        <div className="mt-3 space-y-2">
          <Textarea
            placeholder="Notes (required for reject, optional for approve)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={pending}
              onClick={() => act("APPROVED")}
            >
              {pending && pendingDecision === "APPROVED" ? "Approving…" : "Approve"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={pending}
              onClick={() => act("REJECTED")}
            >
              {pending && pendingDecision === "REJECTED" ? "Rejecting…" : "Reject"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
