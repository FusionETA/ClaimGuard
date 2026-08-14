"use client"

import { useActionState, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"

import {
  submitTimeAdjustmentAction,
  type SubmitAdjustmentState,
} from "./actions"

type Props = {
  recordId: string
  /** Current recorded clock times (ISO UTC) — prefill + reconstruct source. */
  currentTimeInUtc: string | null
  currentTimeOutUtc: string | null
  /** System-captured off-site context, shown read-only for reference. */
  offSiteNotes?: string | null
}

// HH:mm (browser-local) for a stored ISO instant. Browser tz == org tz for
// the Malaysian deployment, so the wall-clock the employee sees and edits
// matches what the supervisor sees.
function toTimeInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// Rebuild a UTC ISO from the original event's local date + a new HH:mm.
// Keeps the same calendar day as the original clock event (a same-session
// correction), swapping only the time-of-day.
function reconstructUtc(originalIso: string, hhmm: string): string {
  const d = new Date(originalIso)
  const [hh, mm] = hhmm.split(":").map(Number)
  d.setHours(hh ?? 0, mm ?? 0, 0, 0)
  return d.toISOString()
}

/**
 * "Request adjustment" card for the current session. Distinct from the
 * clock button: the employee proposes the CORRECT clock-in/out time + a
 * reason, and it goes to their supervisor as an approval request. Nothing
 * is written to the record until approved, and the original is preserved.
 * Replaces the old free-text remark card.
 */
export function TodayAdjustmentCard({
  recordId,
  currentTimeInUtc,
  currentTimeOutUtc,
  offSiteNotes,
}: Props) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [timeIn, setTimeIn] = useState(toTimeInput(currentTimeInUtc))
  const [timeOut, setTimeOut] = useState(toTimeInput(currentTimeOutUtc))
  const [reason, setReason] = useState("")

  const [state, formAction, pending] = useActionState<
    SubmitAdjustmentState,
    FormData
  >(submitTimeAdjustmentAction, {})

  useEffect(() => {
    if (state.ok) {
      toast({
        title: "Adjustment request sent for approval.",
        variant: "success",
      })
      setOpen(false)
      setReason("")
    } else if (state.error) {
      toast({ title: state.error, variant: "error" })
    }
  }, [state, toast])

  // Only submit a field the employee actually changed from the record.
  const requestedInUtc =
    currentTimeInUtc && timeIn && timeIn !== toTimeInput(currentTimeInUtc)
      ? reconstructUtc(currentTimeInUtc, timeIn)
      : ""
  const requestedOutUtc =
    currentTimeOutUtc && timeOut && timeOut !== toTimeInput(currentTimeOutUtc)
      ? reconstructUtc(currentTimeOutUtc, timeOut)
      : ""

  const hasChange = Boolean(requestedInUtc || requestedOutUtc)
  const canSubmit = hasChange && reason.trim().length > 0

  if (!open) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Wrong clock time?
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Request a correction — your supervisor reviews and approves it.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setOpen(true)}
          >
            Request adjustment
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Request time adjustment
          </p>
          <span className="text-[10px] text-muted-foreground">
            Needs supervisor approval
          </span>
        </div>

        {offSiteNotes ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            <p className="font-bold">⚠ Off-site context (read-only)</p>
            <pre className="mt-1 whitespace-pre-wrap font-sans">
              {offSiteNotes}
            </pre>
          </div>
        ) : null}

        <form action={formAction} className="space-y-3">
          <input type="hidden" name="recordId" value={recordId} />
          <input type="hidden" name="requestedTimeInUtc" value={requestedInUtc} />
          <input
            type="hidden"
            name="requestedTimeOutUtc"
            value={requestedOutUtc}
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="adj-in" className="text-xs">
                Clock-in
              </Label>
              <Input
                id="adj-in"
                type="time"
                value={timeIn}
                disabled={!currentTimeInUtc || pending}
                onChange={(e) => setTimeIn(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                {currentTimeInUtc
                  ? `Recorded ${toTimeInput(currentTimeInUtc)}`
                  : "Not clocked in"}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-out" className="text-xs">
                Clock-out
              </Label>
              <Input
                id="adj-out"
                type="time"
                value={timeOut}
                disabled={!currentTimeOutUtc || pending}
                onChange={(e) => setTimeOut(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                {currentTimeOutUtc
                  ? `Recorded ${toTimeInput(currentTimeOutUtc)}`
                  : "Not clocked out"}
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="adj-reason" className="text-xs">
              Reason
            </Label>
            <Textarea
              id="adj-reason"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Forgot to clock out — actually finished at 7:00pm."
              rows={2}
              disabled={pending}
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || !canSubmit}>
              {pending ? "Submitting…" : "Submit request"}
            </Button>
          </div>
          {hasChange && reason.trim().length === 0 ? (
            <p className="text-right text-[10px] text-muted-foreground">
              Add a reason to submit.
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}
