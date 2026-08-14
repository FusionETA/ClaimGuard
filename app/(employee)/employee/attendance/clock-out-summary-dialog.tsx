"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { AttendanceRecordView } from "@/modules/attendance/domain/models"

type Props = {
  /**
   * Today's pre-clock-out record. The dialog is open whenever this is
   * non-null. Pass `null` to keep it closed.
   */
  todayRecord: AttendanceRecordView | null
  /** True while the server action is in flight. */
  pending: boolean
  /** Server-returned error from the most recent commit attempt, if any. */
  error: string | null
  /**
   * Called when the user explicitly confirms. Pass `null` for "Looks
   * good" (no adjustment request) or the remark string for "Submit
   * request".
   */
  onConfirm: (adjustmentRequest: string | null) => void
  /**
   * Called when the user dismisses without confirming — closing the
   * dialog must NOT commit the clock-out.
   */
  onClose: () => void
  /** OT daily threshold in minutes. When projected duration >= this, the
   *  shift is classified as overtime and a remark becomes required. */
  otThresholdMin?: number
}

function fmtTime(iso: string | null | Date): string {
  if (!iso) return "—"
  const d = iso instanceof Date ? iso : new Date(iso)
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

function fmtDuration(min: number | null): string {
  if (min == null) return "—"
  const safe = Math.max(0, min)
  const h = Math.floor(safe / 60)
  const m = safe % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * Pre-clock-out confirmation popup. Shows the projected hours for the
 * day along with the existing off-site context and any prior adjustment
 * request. The clock-out only commits when the employee explicitly
 * picks "Looks good" or "Submit request"; closing the dialog cancels
 * the clock-out entirely.
 *
 * Figures reflect the CURRENT open session (from `todayRecord.sessions`),
 * not the whole day — so a re-clock-in shows this shift's window and worked
 * time, and the OT check uses the projected day total rather than the span
 * from the first clock-in. The server recomputes authoritative values on
 * commit.
 */
export function ClockOutSummaryDialog({
  todayRecord,
  pending,
  error,
  onConfirm,
  onClose,
  otThresholdMin,
}: Props) {
  const [remark, setRemark] = useState("")

  // Reset the remark editor whenever the dialog opens fresh.
  useEffect(() => {
    if (todayRecord) {
      setRemark(todayRecord.remark ?? "")
    }
  }, [todayRecord])

  const open = todayRecord !== null
  if (!todayRecord) return null

  const now = new Date()

  // Reflect the CURRENT open session being clocked out — NOT the whole day.
  // On a re-clock-in (multiple shifts), `todayRecord.timeIn` is the day's
  // FIRST clock-in, which would wrongly show the full-day span, inflate the
  // worked total, and trip the OT warning for a short second shift.
  const openSession =
    todayRecord.sessions.find((s) => s.startedAt && !s.endedAt) ?? null
  const sessionStart = openSession?.startedAt ?? todayRecord.timeIn
  const isReclockIn = todayRecord.sessions.filter((s) => s.endedAt).length > 0
  // Which shift this is today — the open session is the latest, so its
  // position is the session count. Gives the employee context that these
  // times are for their current shift, not the whole day.
  const shiftNumber = Math.max(1, todayRecord.sessions.length)

  // This session's worked minutes so far (minus any break currently open).
  let sessionWorkedMin: number | null = null
  if (sessionStart) {
    const raw = Math.round(
      (now.getTime() - new Date(sessionStart).getTime()) / 60000,
    )
    let worked = Math.max(0, raw)
    if (todayRecord.onBreak && todayRecord.currentBreakStartedAt) {
      const brk = Math.round(
        (now.getTime() - new Date(todayRecord.currentBreakStartedAt).getTime()) /
          60000,
      )
      worked = Math.max(0, worked - Math.max(0, brk))
    }
    sessionWorkedMin = worked
  }

  // OT is a DAILY threshold — check the projected day total (already-clocked
  // completed sessions + this session so far), not the span from the first
  // clock-in. Prevents a 1-minute second shift from reading as overtime.
  const projectedDayWorkedMin =
    (todayRecord.durationMin ?? 0) + (sessionWorkedMin ?? 0)
  const isOt = otThresholdMin != null && projectedDayWorkedMin >= otThresholdMin
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ready to clock out?</DialogTitle>
          <DialogDescription>
            Review today&apos;s working hours. If something looks off, add an
            adjustment request below for your supervisor to review. Closing
            this dialog cancels the clock-out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-2xl border border-border/60 bg-surface-low p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Working hours
              </p>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                Shift {shiftNumber} today
              </span>
            </div>
            <p className="mt-1 font-headline text-xl font-extrabold text-foreground">
              {fmtTime(sessionStart)} – {fmtTime(now)}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Worked
                </p>
                <p className="mt-0.5 text-sm font-bold text-foreground">
                  {fmtDuration(sessionWorkedMin)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  On break
                </p>
                <p className="mt-0.5 text-sm font-bold text-foreground">
                  {fmtDuration(todayRecord.breakMin > 0 ? todayRecord.breakMin : 0)}
                </p>
              </div>
              {todayRecord.project ? (
                <div className="col-span-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Project
                  </p>
                  <p className="mt-0.5 text-sm font-bold text-foreground">
                    🛠 {todayRecord.project}
                  </p>
                </div>
              ) : null}
              {!isReclockIn && todayRecord.lateByMin && todayRecord.lateByMin > 0 ? (
                <div className="col-span-2">
                  <p className="text-[10px] uppercase tracking-wider text-tertiary">
                    Started late
                  </p>
                  <p className="mt-0.5 text-sm font-bold text-tertiary">
                    +{todayRecord.lateByMin}m past shift start
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          {todayRecord.notes ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <p className="font-bold">⚠ Off-site context</p>
              <pre className="mt-1 whitespace-pre-wrap font-sans">
                {todayRecord.notes}
              </pre>
              <p className="mt-1 text-[10px] text-amber-800/80">
                Captured automatically when you clocked in/out outside the
                geofence. Not editable here.
              </p>
            </div>
          ) : null}

          {isOt ? (
            <div className="rounded-md border border-orange-300 bg-orange-50 p-3 text-xs text-orange-900">
              <p className="font-bold">⏱ Overtime detected</p>
              <p className="mt-0.5">
                Your shift has exceeded the OT threshold. A shift remark is
                required before clocking out.
              </p>
            </div>
          ) : null}

          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {isOt ? "Shift remark (required)" : "Adjustment request (optional)"}
            </span>
            <Textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder={
                isOt
                  ? "Describe what you worked on during overtime…"
                  : "e.g. forgot to clock out at 6pm — actually finished at 7:15"
              }
              rows={4}
              disabled={pending}
              className="w-full resize-y"
            />
            {isOt ? null : (
              <p className="text-[10px] text-muted-foreground">
                Describe what should be adjusted. Your supervisor will see this
                alongside today&apos;s record.
              </p>
            )}
          </label>

          {error ? (
            <p className="text-xs font-semibold text-destructive">{error}</p>
          ) : null}

          <DialogFooter className="gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              size="lg"
              disabled={pending || (isOt && !remark.trim())}
              onClick={() => onConfirm(remark.trim() || null)}
              className="w-full shadow-sm"
            >
              {pending ? "Clocking out…" : "Confirm clock out"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
