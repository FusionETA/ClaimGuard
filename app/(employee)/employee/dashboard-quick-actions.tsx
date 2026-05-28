"use client"

import { useState } from "react"
import { ArrowRight, Plus } from "lucide-react"

import { ClaimFlow } from "@/app/(employee)/employee/claims/new/claim-flow"
import {
  ApplyForm,
  type BalanceRow,
} from "@/components/employee/leave/employee-leave-view"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  ChartAccountWithRemainingLimit,
  ClaimRunPreview,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

type Props = {
  chartAccounts: ChartAccountWithRemainingLimit[]
  mileageAccounts: ChartAccountWithRemainingLimit[]
  bankAccounts: ChartOfAccountOption[]
  defaultMileageRate?: number
  mileageUnit: "KM" | "MILE"
  claimRunPreview?: ClaimRunPreview
  organizationName?: string
  employeeProjects?: Array<{ id: string; name: string }>
  allowedCurrencies?: string[]
  defaultCurrency?: string
  /// Leave balances for the employee. When provided (and non-empty),
  /// the 'Request leave' button opens the apply-for-leave dialog
  /// directly — same UX as the standalone Submit Leave card used
  /// to give. Omit / pass [] when the leave module is disabled to
  /// hide the button entirely.
  leaveBalances?: BalanceRow[]
}

export function DashboardQuickActions({
  chartAccounts,
  mileageAccounts,
  bankAccounts,
  defaultMileageRate,
  mileageUnit,
  claimRunPreview,
  organizationName,
  employeeProjects,
  allowedCurrencies,
  defaultCurrency,
  leaveBalances,
}: Props) {
  const [open, setOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)

  const showLeaveButton = (leaveBalances?.length ?? 0) > 0

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="h-11 justify-between rounded-2xl px-4 text-sm sm:h-12 sm:rounded-xl sm:px-6 sm:text-base xl:h-10 xl:px-5 xl:text-[0.95rem]"
      >
        Submit new claim
        <Plus className="h-4 w-4" />
      </Button>

      {showLeaveButton ? (
        <Button
          variant="outline"
          onClick={() => setLeaveOpen(true)}
          className="h-11 justify-between rounded-2xl px-4 text-sm sm:h-12 sm:rounded-xl sm:px-6 sm:text-base xl:h-10 xl:px-5 xl:text-[0.95rem]"
        >
          Request leave
          <ArrowRight className="h-4 w-4" />
        </Button>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[90vh] w-[min(92vw,680px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[680px]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader className="shrink-0 border-b border-border/60 pb-4 pr-8">
            <DialogTitle>Submit a claim</DialogTitle>
            <DialogDescription>
              Fill in the details and attach a receipt if you have one.
            </DialogDescription>
          </DialogHeader>

          <div
            className="flex-1 overflow-y-auto pr-1 pt-4"
            style={{ scrollbarGutter: "stable both-edges" }}
          >
            <ClaimFlow
              compact
              chartAccounts={chartAccounts}
              mileageAccounts={mileageAccounts}
              bankAccounts={bankAccounts}
              defaultMileageRate={defaultMileageRate}
              mileageUnit={mileageUnit}
              claimRunPreview={claimRunPreview}
              organizationName={organizationName}
              employeeProjects={employeeProjects}
              allowedCurrencies={allowedCurrencies}
              defaultCurrency={defaultCurrency}
              onSuccess={() => setOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>

      {showLeaveButton ? (
        <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
          <DialogContent
            className="flex max-h-[90vh] w-[min(92vw,640px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[640px]"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <DialogHeader className="shrink-0 border-b border-border/60 pb-4 pr-8">
              <DialogTitle>Apply for leave</DialogTitle>
              <DialogDescription>
                Pick a leave type and dates. Attach an MC slip if relevant.
              </DialogDescription>
            </DialogHeader>
            <div
              className="flex-1 overflow-y-auto pr-1 pt-4"
              style={{ scrollbarGutter: "stable both-edges" }}
            >
              <ApplyForm
                balances={leaveBalances ?? []}
                onSuccess={() => setLeaveOpen(false)}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
