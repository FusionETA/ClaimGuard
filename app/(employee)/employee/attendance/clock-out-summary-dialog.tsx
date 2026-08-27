"use client"

import { useEffect, useState } from "react"
import { Clock, PencilLine } from "lucide-react"

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
import { cn } from "@/lib/utils"
import type { AttendanceRecordView } from "@/modules/attendance/domain/models"

/** What the employee confirmed in the dialog. */
export type ClockOutConfirmation = {
  /** OT / shift remark from the Summary tab (null when none). */
  remark: string | null
  /**
   * Time-adjustment request from the Adjustment tab. When present the
   * employee is still clocked out at the ACTUAL time now; this files a
   * pending request for the supervisor to approve (apply) or reject
   * (keep original). `requestedTimeOutUtc` is a UTC ISO string.
   */
  adjustment: { requestedTimeOutUtc: string; reason: string } | null
}

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
  /** Called when the user explicitly confirms the clock-out. */
  onConfirm: (confirmation: ClockOutConfirmation) => void
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

/** Local "HH:MM" for a Date (for the <input type="time"> default). */
export function toHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** Combine an "HH:MM" (today, local) into a UTC ISO string. */
export function hhmmToUtcIso(hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  return d.toISOString()
}

/**
 * Pre-clock-out confirmation popup with two tabs:
 *   • Summary — projected hours + off-site context; the employee confirms
 *     the clock-out at the actual time (an OT shift requires a remark).
 *   • Request adjustment — the employee keys in the CORRECTED clock-out
 *     time + a reason. Submitting still clocks them out NOW (at the real
 *     time); it files a pending request the supervisor approves (applies
 *     the corrected time) or rejects (keeps the original).
 *
 * Closing the dialog cancels the clock-out entirely. Figures reflect the
 * CURRENT open session, not the whole day; the server recomputes
 * authoritative values on commit.
 */
export function ClockOutSummaryDialog({
  todayRecord,
  pending,
  error,
  onConfirm,
  onClose,
  otThresholdMin,
}: Props) {
  const [tab, setTab] = useState<"summary" | "adjust">("summary")
  const [remark, setRemark] = useState("")
  const [adjustTime, setAdjustTime] = useState("")
  const [adjustReason, setAdjustReason] = useState("")

  // Reset the editors whenever the dialog opens fresh.
  useEffect(() => {
    if (todayRecord) {
      setTab("summary")
      setRemark(todayRecord.remark ?? "")
      setAdjustTime(toHHMM(new Date()))
      setAdjustReason("")
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

  // OT is a DAILY threshold — check the projected day total.
  const projectedDayWorkedMin =
    (todayRecord.durationMin ?? 0) + (sessionWorkedMin ?? 0)
  const isOt = otThresholdMin != null && projectedDayWorkedMin >= otThresholdMin

  const requestedIso = hhmmToUtcIso(adjustTime)
  const adjustValid = requestedIso != null && adjustReason.trim().length > 0

  function confirmSummary() {
    onConfirm({ remark: remark.trim() || null, adjustment: null })
  }
  function confirmAdjustment() {
    if (!requestedIso || !adjustReason.trim()) return
    onConfirm({
      remark: null,
      adjustment: { requestedTimeOutUtc: requestedIso, reason: adjustReason.trim() },
    })
  }

  const tabBtn = (
    id: "summary" | "adjust",
    label: string,
    Icon: typeof Clock,
  ) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      disabled={pending}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors",
        tab === id
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )

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
            Review today&apos;s working hours, or request a time correction.
            Closing this dialog cancels the clock-out.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-2xl border border-border/60 bg-surface-low p-1">
          {tabBtn("summary", "Summary", Clock)}
          {tabBtn("adjust", "Request adjustment", PencilLine)}
        </div>

        {tab === "summary" ? (
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

            {isOt ? (
              <label className="block space-y-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Shift remark (required)
                </span>
                <Textarea
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="Describe what you worked on during overtime…"
                  rows={3}
                  disabled={pending}
                  className="w-full resize-y"
                />
              </label>
            ) : null}

            {error ? (
              <p className="text-xs font-semibold text-destructive">{error}</p>
            ) : null}

            <DialogFooter className="gap-2 border-t border-border/60 pt-3">
              <Button
                type="button"
                size="lg"
                disabled={pending || (isOt && !remark.trim())}
                onClick={confirmSummary}
                className="w-full shadow-sm"
              >
                {pending ? "Clocking out…" : "Confirm clock out"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-700">
                <Clock className="h-4 w-4" />
              </div>
              <p className="text-xs leading-relaxed text-amber-900">
                You&apos;ll be clocked out now at the actual time (
                <strong className="font-bold">{fmtTime(now)}</strong>). This
                sends your supervisor a request to change the clock-out time —
                they approve (uses your time) or reject (keeps the actual
                time).
              </p>
            </div>

            <label className="block space-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-900">
                Corrected clock-out time
              </span>
              <input
                type="time"
                value={adjustTime}
                onChange={(e) => setAdjustTime(e.target.value)}
                disabled={pending}
                className="block w-full rounded-2xl border border-amber-200 bg-white px-4 py-3 text-base font-semibold text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm appearance-none text-left [&::-webkit-date-and-time-value]:text-left [&::-webkit-date-and-time-value]:m-0"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-900">
                Reason (required)
              </span>
              <Textarea
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="e.g. forgot to clock out — actually finished at 7:15pm"
                rows={3}
                disabled={pending}
                className="w-full resize-y border-amber-200 bg-white shadow-sm focus-visible:ring-amber-400"
              />
            </label>

            {error ? (
              <p className="text-xs font-semibold text-destructive">{error}</p>
            ) : null}

            <DialogFooter className="gap-2 border-t border-border/60 pt-3">
              <Button
                type="button"
                size="lg"
                disabled={pending || !adjustValid}
                onClick={confirmAdjustment}
                className="w-full bg-amber-500 text-white shadow-sm hover:bg-amber-600"
              >
                {pending ? "Submitting…" : "Submit request & clock out"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
