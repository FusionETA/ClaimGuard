"use client"

import { useState } from "react"
import { ArrowRight, Plus } from "lucide-react"
import Link from "next/link"

import { ClaimForm } from "@/app/(employee)/employee/claims/new/claim-form"
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
}: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="h-11 justify-between rounded-2xl px-4 text-sm sm:h-12 sm:rounded-xl sm:px-6 sm:text-base xl:h-10 xl:px-5 xl:text-[0.95rem]"
      >
        Submit new claim
        <Plus className="h-4 w-4" />
      </Button>

      <Button
        asChild
        variant="outline"
        className="h-11 justify-between rounded-2xl px-4 text-sm sm:h-12 sm:rounded-xl sm:px-6 sm:text-base xl:h-10 xl:px-5 xl:text-[0.95rem]"
      >
        <Link href="/employee/leave">
          Request leave
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[90vh] w-[min(92vw,680px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[680px]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>Submit a claim</DialogTitle>
            <DialogDescription>
              Fill in the details and attach a receipt if you have one.
            </DialogDescription>
          </DialogHeader>

          <div
            className="flex-1 overflow-y-auto pr-1"
            style={{ scrollbarGutter: "stable both-edges" }}
          >
            <ClaimForm
              compact
              chartAccounts={chartAccounts}
              mileageAccounts={mileageAccounts}
              bankAccounts={bankAccounts}
              defaultMileageRate={defaultMileageRate}
              mileageUnit={mileageUnit}
              claimRunPreview={claimRunPreview}
              organizationName={organizationName}
              employeeProjects={employeeProjects}
              onSuccess={() => setOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
