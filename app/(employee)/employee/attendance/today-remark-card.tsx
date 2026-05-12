"use client"

import { useActionState, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"

import {
  updateTodayRemarkAction,
  type UpdateRemarkState,
} from "./actions"

type Props = {
  recordId: string
  /** Initial value of `AttendanceRecord.remark` (employee adjustment request). */
  initialRemark: string | null
  /**
   * Off-site context auto-captured during clock-in/out (`notes`). Shown
   * read-only above the editor when present so the employee can see what
   * their supervisor will see. Not editable from this card.
   */
  offSiteNotes?: string | null
}

/**
 * Today's adjustment-request card for the employee. Writes to
 * `AttendanceRecord.remark` (not `.notes`) so it never mixes with the
 * off-site context the system captures automatically at clock-in/out.
 * The repo layer enforces "today only".
 */
export function TodayRemarkCard({ recordId, initialRemark, offSiteNotes }: Props) {
  const { toast } = useToast()
  const [remark, setRemark] = useState(initialRemark ?? "")
  const [state, formAction, pending] = useActionState<UpdateRemarkState, FormData>(
    updateTodayRemarkAction,
    {},
  )

  useEffect(() => {
    if (state.ok) {
      toast({ title: "Adjustment request submitted.", variant: "success" })
    } else if (state.error) {
      toast({ title: state.error, variant: "error" })
    }
  }, [state, toast])

  const dirty = (remark ?? "").trim() !== (initialRemark ?? "").trim()

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Adjustment request
          </p>
          <span className="text-[10px] text-muted-foreground">
            Visible to your supervisor and admins
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
        <form action={formAction} className="space-y-2">
          <input type="hidden" name="recordId" value={recordId} />
          <Textarea
            name="remark"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Need an adjustment for today? e.g. forgot to clock out at 6pm — actually finished at 7:15."
            rows={3}
            disabled={pending}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={pending || !dirty}>
              {pending ? "Submitting…" : "Submit request"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
