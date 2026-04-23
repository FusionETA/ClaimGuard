"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { ExternalLink, LoaderCircle } from "lucide-react"

import { reviewClaimAction } from "@/app/(employee)/employee/review/actions"
import { createInitialReviewClaimFormState } from "@/app/(admin)/admin/claims/form-state"
import { ClaimCategoryIcon } from "@/components/claims/claim-category-icon"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"
import { categoryMeta } from "@/modules/claims/domain/metadata"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import type { ClaimRecord, ClaimStatus } from "@/modules/claims/domain/models"

function isActionableStatus(status: ClaimStatus) {
  return status === "SUBMITTED" || status === "PENDING"
}

export function AdminClaimReviewActions({ claim }: { claim: ClaimRecord }) {
  const { toast } = useToast()
  const initialState = useMemo(
    () => createInitialReviewClaimFormState(claim.reviewNotes ?? ""),
    [claim.reviewNotes]
  )
  const [state, formAction, pending] = useActionState(reviewClaimAction, initialState)
  const [reason, setReason] = useState(claim.reviewNotes ?? "")
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setReason(state.values.reason)
  }, [state.values.reason])

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
    }
    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
  }, [state.status, state.message, toast])

  const currentStatus = state.claimStatus ?? claim.status
  const actionable = isActionableStatus(currentStatus)
  const reviewNote = reason.trim()
  const reviewerName = state.reviewerName ?? claim.reviewerName

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={actionable ? "default" : "outline"}
          size="sm"
          className="relative z-10 touch-manipulation"
        >
          {actionable ? "Review" : "View"}
        </Button>
      </DialogTrigger>

      <DialogContent
        className="max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex flex-col gap-3 pr-14 sm:flex-row sm:items-start sm:justify-between sm:pr-16">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {claim.claimNumber}
              </p>
              <DialogTitle className="mt-2">{claim.title}</DialogTitle>
            </div>
            <div className="w-fit">
              <ClaimStatusBadge status={currentStatus} />
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-5">
            <div className="rounded-[28px] bg-surface-low p-5">
              <p className="text-sm font-semibold text-foreground">Business context</p>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{claim.description}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-[24px] bg-surface-low p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Employee</p>
                <p className="mt-2 text-xl font-black">{claim.employee.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{claim.employee.jobTitle}</p>
                <p className="text-sm text-muted-foreground">{claim.employee.project}</p>
              </div>
              <div className="rounded-[24px] bg-surface-low p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Amount</p>
                <p className="mt-2 text-xl font-black">{formatCurrency(claim.amount)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{claim.currency}</p>
              </div>
              <div className="rounded-[24px] bg-surface-low p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Category</p>
                <div className="mt-2 flex items-center gap-2 text-foreground">
                  <ClaimCategoryIcon category={claim.category} className="h-5 w-5 text-primary" />
                  <span className="font-semibold">{categoryMeta[claim.category].label}</span>
                </div>
              </div>
              <div className="rounded-[24px] bg-surface-low p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Submitted</p>
                <p className="mt-2 text-xl font-black">{formatShortDate(claim.submittedAt)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Spent on {formatShortDate(claim.spentAt)}
                </p>
              </div>
            </div>

            {claim.receiptUrl ? (
              <div className="rounded-[24px] border border-border/60 bg-background/80 p-4">
                <p className="text-sm font-semibold text-foreground">Receipt attachment</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Open the uploaded receipt in a new tab for a closer look.
                </p>
                <div className="mt-4">
                  <Button asChild variant="outline">
                    <a href={claim.receiptUrl} target="_blank" rel="noreferrer">
                      View receipt
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-[28px] bg-surface-low p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Review decision</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Submitted {formatShortDate(claim.submittedAt)}
                  {reviewerName ? ` · Last handled by ${reviewerName}` : ""}
                </p>
              </div>
              <ClaimStatusBadge status={currentStatus} />
            </div>

            <form action={formAction} className="mt-5 space-y-4" suppressHydrationWarning>
              <input type="hidden" name="claimId" value={claim.id} suppressHydrationWarning />

              <div className="space-y-2">
                <Label htmlFor={`reason-${claim.id}`}>
                  {actionable ? "Review note" : "Saved review note"}
                </Label>
                <Textarea
                  id={`reason-${claim.id}`}
                  name="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={!actionable || pending}
                  placeholder="Optional for approval. Required when rejecting a claim."
                  className="min-h-[160px] bg-background/80"
                  aria-invalid={Boolean(state.errors.reason)}
                />
                {state.errors.reason ? (
                  <p className="text-sm text-destructive">{state.errors.reason}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  name="decision"
                  value="APPROVED"
                  disabled={!actionable || pending}
                >
                  {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  Approve
                </Button>
                <Button
                  type="submit"
                  name="decision"
                  value="REJECTED"
                  variant="destructive"
                  disabled={!actionable || pending}
                >
                  {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  Reject with reason
                </Button>
              </div>

              {/* <p
                className={
                  state.status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
                }
              >
                {state.message ||
                  (actionable
                    ? "Approval can be submitted without a note. Rejection requires a clear reason."
                    : "This claim is no longer actionable because it has already been reviewed.")}
              </p> */}
            </form>

            {!actionable && reviewNote ? (
              <div className="mt-4 rounded-2xl border border-border bg-background/70 p-3 text-sm text-muted-foreground">
                {reviewNote}
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
