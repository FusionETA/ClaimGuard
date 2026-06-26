"use client"

import * as React from "react"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Plus } from "lucide-react"

import { applyLeaveOnBehalfAction } from "@/app/(admin)/admin/leave/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"

/**
 * "Apply leave for employee" dialog on the admin Leave page.
 *
 * Lets the admin file a leave application without forcing the employee
 * to log in. Submits to `applyLeaveOnBehalfAction`, which lands the
 * row directly as APPROVED + decrements the entitlement balance.
 *
 * UI shape mirrors the employee self-submit form: employee picker,
 * leave type, date range, duration (FULL / AM / PM), optional reason.
 * Closes on success, re-opens with cleared state for the next entry.
 */
export type ApplyLeaveEmployeeOption = {
  /// EmployeeProfile.id — the canonical id the leave service expects.
  employeeProfileId: string
  name: string
  /// Display-only — surfaced as the secondary line in the picker.
  email: string
  employeeId: string
}

export type ApplyLeaveTypeOption = {
  id: string
  code: string
  name: string
}

export function ApplyLeaveOnBehalfDialog({
  employees,
  leaveTypes,
}: {
  employees: ApplyLeaveEmployeeOption[]
  leaveTypes: ApplyLeaveTypeOption[]
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [employeeProfileId, setEmployeeProfileId] = useState<string>("")
  const [leaveTypeId, setLeaveTypeId] = useState<string>("")
  const [startDate, setStartDate] = useState<string>(todayIso())
  const [endDate, setEndDate] = useState<string>(todayIso())
  const [duration, setDuration] = useState<"FULL_DAY" | "MORNING" | "AFTERNOON">("FULL_DAY")
  const [reason, setReason] = useState<string>("")
  const [pending, startTransition] = useTransition()

  // Half-day option is only meaningful for a single-day range —
  // disable the dropdown otherwise so the admin can't pick something
  // the server would reject anyway.
  const sameDay = startDate === endDate && startDate.length > 0
  React.useEffect(() => {
    if (!sameDay && duration !== "FULL_DAY") setDuration("FULL_DAY")
  }, [sameDay, duration])

  const employeeOptions = useMemo(
    () =>
      [...employees].sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  )
  const leaveTypeOptions = useMemo(
    () => [...leaveTypes].sort((a, b) => a.name.localeCompare(b.name)),
    [leaveTypes],
  )

  function resetForm() {
    setEmployeeProfileId("")
    setLeaveTypeId("")
    setStartDate(todayIso())
    setEndDate(todayIso())
    setDuration("FULL_DAY")
    setReason("")
  }

  function handleSubmit() {
    if (!employeeProfileId) {
      toast({ title: "Pick an employee.", variant: "error" })
      return
    }
    if (!leaveTypeId) {
      toast({ title: "Pick a leave type.", variant: "error" })
      return
    }
    if (!startDate || !endDate) {
      toast({ title: "Pick a date range.", variant: "error" })
      return
    }
    if (endDate < startDate) {
      toast({ title: "End date must be on or after start date.", variant: "error" })
      return
    }
    startTransition(async () => {
      const result = await applyLeaveOnBehalfAction({
        employeeProfileId,
        leaveTypeId,
        startDate,
        endDate,
        duration,
        reason: reason.trim() || undefined,
      })
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
      if (result.ok) {
        setOpen(false)
        resetForm()
        router.refresh()
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetForm()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          Apply leave for employee
        </Button>
      </DialogTrigger>
      <DialogContent
        // Same Safari opacity override we use on the claims-review
        // modal — without it the gradient bleeds through the edges.
        className="max-h-[90vh] bg-card backdrop-blur-none dark:bg-card sm:max-w-[520px]"
      >
        <DialogHeader>
          <DialogTitle>Apply leave on behalf</DialogTitle>
          <DialogDescription>
            File leave for an employee without making them log in. Lands
            as APPROVED immediately and decrements their balance.
          </DialogDescription>
        </DialogHeader>

        <div className="nice-scrollbar -mr-2 max-h-[65vh] space-y-4 overflow-y-auto py-2 pl-1 pr-2">
          <div className="space-y-1.5">
            <Label htmlFor="apply-employee">Employee</Label>
            <Select
              value={employeeProfileId || undefined}
              onValueChange={(v) => setEmployeeProfileId(v)}
              disabled={pending}
            >
              <SelectTrigger id="apply-employee" className="h-11">
                <SelectValue placeholder="Pick an employee" />
              </SelectTrigger>
              <SelectContent>
                {employeeOptions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No employees in this organisation.
                  </div>
                ) : (
                  employeeOptions.map((e) => (
                    <SelectItem key={e.employeeProfileId} value={e.employeeProfileId}>
                      {e.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {e.employeeId}
                      </span>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="apply-leave-type">Leave type</Label>
            <Select
              value={leaveTypeId || undefined}
              onValueChange={(v) => setLeaveTypeId(v)}
              disabled={pending}
            >
              <SelectTrigger id="apply-leave-type" className="h-11">
                <SelectValue placeholder="Pick a leave type" />
              </SelectTrigger>
              <SelectContent>
                {leaveTypeOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t.code}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="apply-start">From</Label>
              <Input
                id="apply-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value)
                  // Auto-bump end-date if it falls before the new start.
                  if (endDate && e.target.value > endDate) {
                    setEndDate(e.target.value)
                  }
                }}
                disabled={pending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="apply-end">To</Label>
              <Input
                id="apply-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate || undefined}
                disabled={pending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="apply-duration">Duration</Label>
            <Select
              value={duration}
              onValueChange={(v) =>
                setDuration(v as "FULL_DAY" | "MORNING" | "AFTERNOON")
              }
              disabled={pending || !sameDay}
            >
              <SelectTrigger id="apply-duration" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FULL_DAY">Full day</SelectItem>
                <SelectItem value="MORNING">Morning (half day)</SelectItem>
                <SelectItem value="AFTERNOON">Afternoon (half day)</SelectItem>
              </SelectContent>
            </Select>
            {!sameDay ? (
              <p className="text-xs text-muted-foreground">
                Half-day is only available for single-day leave.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="apply-reason">Reason (optional)</Label>
            <Textarea
              id="apply-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Recorded on the leave application for audit purposes."
              rows={3}
              disabled={pending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={pending}>
            {pending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Apply leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function todayIso(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}
