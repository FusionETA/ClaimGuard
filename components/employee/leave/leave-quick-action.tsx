"use client"

import { useState } from "react"
import { ArrowRight, CalendarDays } from "lucide-react"

import {
  ApplyForm,
  type BalanceRow,
} from "@/components/employee/leave/employee-leave-view"
import { Card } from "@/components/attendance/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/// Dashboard-level "Submit leave" card. Visually matches the supervisor
/// approval cards (icon chip + label + arrow) and opens the same apply
/// dialog used on /employee/leave.
export function LeaveQuickAction({ balances }: { balances: BalanceRow[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full text-left attendance-module !bg-transparent"
      >
        <Card className="flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-foreground">Submit leave</p>
            <p className="text-xs text-muted-foreground">
              Apply for annual, medical, or unpaid leave
            </p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Card>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[90vh] w-[min(92vw,640px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[640px]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>Apply for leave</DialogTitle>
            <DialogDescription>
              Pick a leave type and dates. Attach an MC slip if relevant.
            </DialogDescription>
          </DialogHeader>
          <div
            className="flex-1 overflow-y-auto pr-1"
            style={{ scrollbarGutter: "stable both-edges" }}
          >
            <ApplyForm balances={balances} onSuccess={() => setOpen(false)} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
