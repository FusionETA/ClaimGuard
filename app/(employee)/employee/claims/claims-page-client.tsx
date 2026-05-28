"use client"

import { useState } from "react"
import { Plus } from "lucide-react"

import { ClaimFlow } from "@/app/(employee)/employee/claims/new/claim-flow"
import { EmployeeClaimsHistory } from "@/components/claims/employee-claims-history"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  ChartAccountWithRemainingLimit,
  ClaimRecord,
  ClaimRunPreview,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

type Props = {
  claims: ClaimRecord[]
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
}

export function ClaimsPageClient({
  claims,
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
}: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <EmployeeClaimsHistory claims={claims} />

      <button
        type="button"
        aria-label="New claim"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-panel transition-transform hover:scale-105 active:scale-95 lg:bottom-8 lg:right-8"
      >
        <Plus className="h-6 w-6" />
      </button>

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
    </>
  )
}
