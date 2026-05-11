"use client"

import { useEffect, useState } from "react"
import { useActionState } from "react"
import { PencilLine } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"
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
  // Build "YYYY-MM-DDTHH:MM" in local time.
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
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
    }
  }, [open, initialTimeIn, initialTimeOut])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <PencilLine className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Override attendance times</DialogTitle>
          <DialogDescription>
            {contextLabel ??
              "Adjust the clock-in or clock-out timestamp for this record. The change is recorded in the audit log."}
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="recordId" value={recordId} />
          <input type="hidden" name="employeeId" value={employeeId} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Clock in
              </span>
              <Input
                type="datetime-local"
                name="timeIn"
                value={timeIn}
                onChange={(e) => setTimeIn(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Clock out
              </span>
              <Input
                type="datetime-local"
                name="timeOut"
                value={timeOut}
                onChange={(e) => setTimeOut(e.target.value)}
              />
            </label>
          </div>
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
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
