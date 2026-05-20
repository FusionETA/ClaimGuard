"use client"

import { useState, useTransition } from "react"

import { decideLeaveAction } from "@/app/(employee)/employee/leave/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  currentStep: number
  createdAt: string
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

export function LeaveApprovalsList({ items }: { items: Application[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No pending approvals</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Nothing waiting on you right now.
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      {items.map((a) => (
        <ApprovalCard key={a.id} app={a} />
      ))}
    </div>
  )
}

function ApprovalCard({ app }: { app: Application }) {
  const [notes, setNotes] = useState("")
  const [pending, startTransition] = useTransition()
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(null)
  const [error, setError] = useState<string | null>(null)

  function act(d: "APPROVED" | "REJECTED") {
    if (d === "REJECTED" && notes.trim() === "") {
      setError("Please add a note explaining the rejection.")
      return
    }
    setError(null)
    setDecision(d)
    startTransition(async () => {
      const res = await decideLeaveAction(app.id, d, notes.trim() || undefined)
      if (!res.ok) {
        setError(res.error)
        setDecision(null)
      }
    })
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{app.employeeName}</span>
              <span className="text-xs text-muted-foreground font-mono">
                {app.leaveTypeCode}
              </span>
            </div>
            <div className="text-sm">
              {fmtDate(app.startDate)}
              {app.startDate !== app.endDate && <> → {fmtDate(app.endDate)}</>}
              {app.duration !== "FULL_DAY" && (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({app.duration === "MORNING" ? "AM" : "PM"})
                </span>
              )}
              <span className="ml-2 text-muted-foreground">
                · {app.totalDays} day{app.totalDays === 1 ? "" : "s"} · {app.leaveTypeName}
                {!app.paid && " (unpaid)"}
              </span>
            </div>
            {app.reason && (
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Reason:</span> {app.reason}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Submitted {fmtDate(app.createdAt)} · Step {app.currentStep}
            </div>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <Textarea
            placeholder="Notes (required for reject, optional for approve)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => act("REJECTED")}
            >
              {pending && decision === "REJECTED" ? "Rejecting…" : "Reject"}
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => act("APPROVED")}
            >
              {pending && decision === "APPROVED" ? "Approving…" : "Approve"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
