"use client"

import { Car, Check, Clock3, Receipt, UserCircle2, X, AlertCircle } from "lucide-react"

import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn, formatCurrency, formatShortDate } from "@/lib/utils"
import type {
  ApprovalStepInfo,
  ClaimRecord,
  ClaimType,
} from "@/modules/claims/domain/models"

/**
 * Row-level visual primitives shared between the admin Queue table
 * (`AdminClaimsTable`) and the Ready-to-sync table (`ClaimSyncList`).
 *
 * Each helper used to live inline in `admin-claims-table.tsx`; they were
 * extracted here so the sync page can re-use the same pills, badges, and
 * detail sheet without duplication. Anything claim-specific that needs
 * to render the same in both places belongs here.
 */

/** Pill that flags claims whose amount blew past the chart-of-account
 *  spend limit at submission. Submission was allowed; the badge tells the
 *  admin "this needs a closer look". */
export function OverLimitBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-900"
      title="This claim exceeds the chart-of-account spend limit. Review carefully before approving."
    >
      <AlertCircle className="h-3 w-3" />
      Over limit
    </span>
  )
}

/** Pill for SUBMITTED/PENDING claims surfacing the next approver in the
 *  chain. Returns null for any other status. */
export function AwaitingApproverBadge({ claim }: { claim: ClaimRecord }) {
  if (
    (claim.status !== "SUBMITTED" && claim.status !== "PENDING") ||
    !claim.pendingApprover
  ) {
    return null
  }

  const { name, step, totalSteps } = claim.pendingApprover
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-tertiary-fixed px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-tertiary"
      title={`Awaiting approval from ${name} (Step ${step} of ${totalSteps})`}
    >
      <Clock3 className="h-3 w-3" />
      <span className="normal-case tracking-normal">{name}</span>
      <span className="opacity-70">
        {step}/{totalSteps}
      </span>
    </span>
  )
}

/** Distinguishes Mileage claims from regular Expense claims at a glance. */
export function ClaimTypeBadge({ claimType }: { claimType: ClaimType }) {
  const isMileage = claimType === "MILEAGE"
  const Icon = isMileage ? Car : Receipt
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]",
        isMileage
          ? "bg-tertiary-fixed text-tertiary"
          : "bg-surface-low text-muted-foreground"
      )}
      title={isMileage ? "Mileage claim" : "Expense claim"}
    >
      <Icon className="h-3 w-3" />
      {isMileage ? "Mileage" : "Expense"}
    </span>
  )
}

/** Whether the claim was paid by the company (no reimbursement) or by
 *  the employee (needs reimbursement). When company-paid, the bank
 *  account label appears underneath. */
export function PaymentTypeBadge({
  claim,
  align = "start",
}: {
  claim: ClaimRecord
  align?: "start" | "end"
}) {
  const isCompany = claim.paymentType === "COMPANY"
  const bankAccountLabel = claim.payViaAccount
    ? `${claim.payViaAccount.code} · ${claim.payViaAccount.name}`
    : "Bank account not recorded"

  return (
    <div
      className={cn("flex flex-col gap-1", align === "end" ? "items-end text-right" : "items-start")}
    >
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]",
          isCompany
            ? "bg-primary/12 text-primary"
            : "bg-surface-low text-muted-foreground"
        )}
        title={
          isCompany
            ? "Paid by the company — no reimbursement needed"
            : "Paid by the employee — needs to be reimbursed"
        }
      >
        {isCompany ? "Company" : "Personal"}
      </span>
      {isCompany ? (
        <span className="max-w-[13rem] text-xs font-semibold leading-snug text-muted-foreground">
          {bankAccountLabel}
        </span>
      ) : null}
    </div>
  )
}

/** Numbered approval-step list for the detail sheet. Each step renders
 *  one row per approver; multi-approver-per-step rows share `step.step`
 *  but have a unique `step.approverId`. */
export function ApprovalChainList({ chain }: { chain: ApprovalStepInfo[] }) {
  return (
    <ol className="space-y-2">
      {chain.map((step) => {
        const palette =
          step.state === "approved"
            ? "bg-secondary text-secondary-foreground"
            : step.state === "current"
              ? "bg-tertiary-fixed text-tertiary"
              : step.state === "rejected"
                ? "bg-destructive/12 text-destructive"
                : step.state === "skipped"
                  ? "bg-surface-low text-muted-foreground line-through"
                  : "bg-surface-low text-muted-foreground"

        const Icon =
          step.state === "approved"
            ? Check
            : step.state === "current"
              ? Clock3
              : step.state === "rejected"
                ? X
                : UserCircle2

        return (
          <li
            key={`${step.step}-${step.approverId}`}
            className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2"
          >
            <span
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold",
                palette
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{step.name}</p>
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Step {step.step} · {step.role}
              </p>
              {step.reviewedAt &&
              (step.state === "approved" || step.state === "rejected") ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {step.state === "approved" ? "Approved" : "Rejected"} on{" "}
                  {new Intl.DateTimeFormat("en-MY", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(step.reviewedAt))}
                </p>
              ) : null}
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {step.state === "approved" && "Approved"}
              {step.state === "current" && "Pending"}
              {step.state === "upcoming" && "Upcoming"}
              {step.state === "rejected" && "Rejected"}
              {step.state === "skipped" && "Did not act"}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Right-side detail sheet: shows the full claim — header pills, money,
 *  employee details, approval chain, and receipt. Used by both the queue
 *  table and the sync table when a row is clicked. */
export function ClaimDetailSheet({
  claim,
  open,
  onClose,
}: {
  claim: ClaimRecord | null
  open: boolean
  onClose: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent side="right" className="overflow-y-auto p-6 sm:p-8">
        {claim ? (
          <>
            <SheetHeader>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {claim.claimNumber}
              </p>
              <SheetTitle>{claim.title}</SheetTitle>
              <SheetDescription>
                Submitted {formatShortDate(claim.submittedAt)}
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <ClaimStatusBadge status={claim.status} reviewerRole={claim.reviewerRole} />
                <ClaimTypeBadge claimType={claim.claimType} />
                <PaymentTypeBadge claim={claim} />
                <AwaitingApproverBadge claim={claim} />
                {claim.exceedsLimit ? <OverLimitBadge /> : null}
              </div>
            </SheetHeader>

            <div className="mt-6 space-y-6 pb-2">
              <section className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Amount
                    </p>
                    <p className="mt-1 text-lg font-black">
                      {formatCurrency(claim.amount)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Spent on
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {formatShortDate(claim.spentAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Currency
                    </p>
                    <p className="mt-1 text-sm font-semibold">{claim.currency}</p>
                  </div>
                  {claim.claimRunMonth ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                        Claim run
                      </p>
                      <p className="mt-1 text-sm font-semibold">
                        {formatShortDate(claim.claimRunMonth)}
                      </p>
                    </div>
                  ) : null}
                </div>

                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                    Chart of account
                  </p>
                  <p className="mt-1 text-sm font-semibold">
                    {claim.chartOfAccount
                      ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                      : "Not assigned"}
                  </p>
                </div>

                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                    Description
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {claim.description}
                  </p>
                </div>

                {claim.reviewNotes ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Reviewer notes
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {claim.reviewNotes}
                    </p>
                  </div>
                ) : null}
              </section>

              <Separator />

              <section>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Employee
                </p>
                <div className="mt-2 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-bold">{claim.employee.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {claim.employee.jobTitle}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {claim.employee.email}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Project
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {claim.employee.project || "—"}
                    </p>
                  </div>
                  {claim.employee.supervisorName ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                        Direct supervisor
                      </p>
                      <p className="mt-1 text-sm font-semibold">
                        {claim.employee.supervisorName}
                      </p>
                    </div>
                  ) : null}
                  {claim.organizationName ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                        Organization
                      </p>
                      <p className="mt-1 text-sm font-semibold">
                        {claim.organizationName}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Approval chain
                </p>
                {claim.approvalChain && claim.approvalChain.length > 0 ? (
                  <ApprovalChainList chain={claim.approvalChain} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No approval chain configured for this employee.
                  </p>
                )}
              </section>

              {claim.receiptUrl ? (
                <>
                  <Separator />
                  <section className="space-y-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Receipt
                    </p>
                    <a
                      href={claim.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block overflow-hidden rounded-xl border border-border/60 bg-surface-low"
                    >
                      {/\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(claim.receiptUrl) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={claim.receiptUrl}
                          alt="Receipt"
                          className="block h-auto w-full"
                        />
                      ) : (
                        <p className="px-4 py-3 text-sm font-semibold text-primary underline-offset-2 hover:underline">
                          Open receipt
                        </p>
                      )}
                    </a>
                  </section>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
