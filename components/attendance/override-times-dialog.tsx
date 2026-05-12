"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { Clock, LogIn, LogOut, PencilLine } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { DateTimeField } from "@/components/attendance/datetime-field"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  overrideAttendanceAction,
  type OverrideAttendanceState,
} from "@/app/(employee)/employee/attendance/team/[employeeId]/actions"

type Props = {
  recordId: string
  employeeId: string
  /** ISO datetime of the current clock-in, or null if missing. */
  initialTimeIn: string | null
  /** ISO datetime of the current clock-out, or null if missing. */
  initialTimeOut: string | null
  /** Label shown on the trigger button. */
  triggerLabel?: string
  /** Optional context shown above the form (e.g. record date). */
  contextLabel?: string
}

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

function fmtTime(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

function fmtDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null
  const a = new Date(start)
  const b = new Date(end)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  const mins = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * Convert the local-datetime input string back to an ISO so we can
 * compute and preview the projected duration consistently with what the
 * server will store.
 */
function localInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function OverrideTimesDialog({
  recordId,
  employeeId,
  initialTimeIn,
  initialTimeOut,
  triggerLabel = "Edit times",
  contextLabel,
}: Props) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [timeIn, setTimeIn] = useState(toLocalDatetimeInput(initialTimeIn))
  const [timeOut, setTimeOut] = useState(toLocalDatetimeInput(initialTimeOut))
  const [reason, setReason] = useState("")
  const [state, formAction, pending] = useActionState<
    OverrideAttendanceState,
    FormData
  >(overrideAttendanceAction, {})

  useEffect(() => {
    if (state.ok) {
      toast({ title: "Attendance times updated.", variant: "success" })
      setOpen(false)
      setReason("")
    } else if (state.error) {
      toast({ title: state.error, variant: "error" })
    }
  }, [state, toast])

  useEffect(() => {
    if (open) {
      setTimeIn(toLocalDatetimeInput(initialTimeIn))
      setTimeOut(toLocalDatetimeInput(initialTimeOut))
      setReason("")
    }
  }, [open, initialTimeIn, initialTimeOut])

  const initialDuration = useMemo(
    () => fmtDuration(initialTimeIn, initialTimeOut),
    [initialTimeIn, initialTimeOut],
  )
  const projectedDuration = useMemo(
    () => fmtDuration(localInputToIso(timeIn), localInputToIso(timeOut)),
    [timeIn, timeOut],
  )

  const timeInChanged = timeIn !== toLocalDatetimeInput(initialTimeIn)
  const timeOutChanged = timeOut !== toLocalDatetimeInput(initialTimeOut)
  const anythingChanged = timeInChanged || timeOutChanged

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <PencilLine className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
              <Clock className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <DialogTitle>Override attendance times</DialogTitle>
              <DialogDescription className="mt-1">
                {contextLabel
                  ? `${contextLabel}. Every change is captured in the audit log.`
                  : "Adjust the clock-in or clock-out timestamp for this record. Every change is captured in the audit log."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="rounded-2xl border border-border/60 bg-surface-low p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Current
          </p>
          <p className="mt-1 font-headline text-lg font-extrabold text-foreground">
            {fmtTime(initialTimeIn)} – {fmtTime(initialTimeOut)}
          </p>
          {initialDuration ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {initialDuration} worked (pre-break)
            </p>
          ) : null}
        </div>

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="recordId" value={recordId} />
          <input type="hidden" name="employeeId" value={employeeId} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TimeField
              icon={<LogIn className="h-3.5 w-3.5" />}
              label="Clock in"
              name="timeIn"
              value={timeIn}
              onChange={setTimeIn}
              changed={timeInChanged}
              tint="success"
            />
            <TimeField
              icon={<LogOut className="h-3.5 w-3.5" />}
              label="Clock out"
              name="timeOut"
              value={timeOut}
              onChange={setTimeOut}
              changed={timeOutChanged}
              tint="destructive"
            />
          </div>

          {projectedDuration ? (
            <div
              className={cn(
                "rounded-xl border px-3 py-2 text-xs",
                anythingChanged
                  ? "border-primary/40 bg-primary/5 text-primary"
                  : "border-border/60 bg-surface-low text-muted-foreground",
              )}
            >
              <span className="font-semibold">Projected duration:</span>{" "}
              {projectedDuration}
              {anythingChanged && initialDuration ? (
                <span className="ml-2 text-muted-foreground">
                  (was {initialDuration})
                </span>
              ) : null}
            </div>
          ) : null}

          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Reason (optional)
            </span>
            <Textarea
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. phone died, confirmed by site lead"
              rows={3}
            />
          </label>

          <DialogFooter className="gap-2 border-t border-border/60 pt-3 sm:flex-row-reverse">
            <Button
              type="submit"
              size="lg"
              disabled={pending || !anythingChanged}
              className="flex-1 shadow-sm"
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
            <DialogClose asChild>
              <Button
                type="button"
                size="lg"
                variant="outline"
                disabled={pending}
                className="flex-1 border-2"
              >
                Cancel
              </Button>
            </DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TimeField({
  icon,
  label,
  name,
  value,
  onChange,
  changed,
  tint,
}: {
  icon: React.ReactNode
  label: string
  name: string
  value: string
  onChange: (next: string) => void
  changed: boolean
  tint: "success" | "destructive"
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border p-3 transition-colors",
        changed
          ? tint === "success"
            ? "border-success/40 bg-success/5"
            : "border-destructive/40 bg-destructive/5"
          : "border-border/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span
          className={cn(
            "rounded-lg p-1",
            tint === "success"
              ? "bg-success/10 text-success"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {icon}
        </span>
        {label}
        {changed ? (
          <span
            className={cn(
              "ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
              tint === "success"
                ? "bg-success/15 text-success"
                : "bg-destructive/15 text-destructive",
            )}
          >
            Edited
          </span>
        ) : null}
      </div>
      <DateTimeField value={value} onChange={onChange} compact />
      {/* Hidden mirror so the form submission still carries the value
          under the expected field name even though DateTimeField is
          uncontrolled at the form layer. */}
      <input type="hidden" name={name} value={value} />
    </div>
  )
}
