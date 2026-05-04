"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { Banknote, Car, Check, Clock3, Receipt, Search, UserCircle2, X } from "lucide-react"

import { markClaimPaidAction, type MarkPaidFormState } from "@/app/(admin)/admin/claims/actions"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PaginationControls } from "@/components/ui/pagination-controls"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn, formatCurrency, formatShortDate } from "@/lib/utils"
import {
  claimMatchesStatusFilter,
  visibleStatusOptions,
  type ApprovalStepInfo,
  type ClaimRecord,
  type ClaimStatus,
  type ClaimType,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

const PAGE_SIZE = 10

const statusLabels: Record<ClaimStatus, string> = {
  SUBMITTED: "Pending",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PAID: "Paid",
  SETTLED: "Settled",
}

// `visibleStatusOptions` and the SUBMITTED-folds-into-PENDING rule live in
// the claims domain so the admin table, supervisor queue, and employee
// history can't drift apart.
// `claimStatuses` is left imported in case other parts of this file consume it.

const initialPayState: MarkPaidFormState = { status: "idle", message: "" }

function PayDialog({
  claim,
  bankAccounts,
  open,
  onClose,
}: {
  claim: ClaimRecord
  bankAccounts: ChartOfAccountOption[]
  open: boolean
  onClose: () => void
}) {
  const [selectedBank, setSelectedBank] = useState("")
  const [state, action, pending] = useActionState(markClaimPaidAction, initialPayState)

  // Close the dialog on success
  useEffect(() => {
    if (state.status === "success") {
      onClose()
    }
  }, [state.status, onClose])

  // Reset bank selection when dialog opens
  useEffect(() => {
    if (open) setSelectedBank("")
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="w-[min(92vw,480px)] sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Mark as paid</DialogTitle>
          <DialogDescription>
            Select the bank account this claim will be paid from. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Claim summary */}
          <div className="rounded-xl border border-border/70 bg-surface-low p-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {claim.claimNumber}
            </p>
            <p className="mt-1 font-bold">{claim.title}</p>
            <p className="mt-0.5 text-muted-foreground">{claim.employee.name}</p>
            <p className="mt-2 text-lg font-black">{formatCurrency(claim.amount)}</p>
          </div>

          <form action={action} id="pay-form">
            <input type="hidden" name="claimId" value={claim.id} />
            <input type="hidden" name="bankAccountId" value={selectedBank} />

            <div className="space-y-2">
              <Label htmlFor="bank-select">Pay from bank account</Label>
              {bankAccounts.length === 0 ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
                  No bank accounts configured. Add bank accounts in{" "}
                  <a href="/admin/settings?tab=banks" className="font-semibold underline">
                    Settings → Bank accounts
                  </a>
                  .
                </p>
              ) : (
                <Select value={selectedBank} onValueChange={setSelectedBank}>
                  <SelectTrigger id="bank-select">
                    <SelectValue placeholder="Select bank account" />
                  </SelectTrigger>
                  <SelectContent>
                    {bankAccounts.map((bank) => (
                      <SelectItem key={bank.id} value={bank.id}>
                        {bank.code} · {bank.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {state.status === "error" ? (
              <p className="mt-3 text-sm text-destructive">{state.message}</p>
            ) : null}
          </form>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="pay-form"
            disabled={pending || !selectedBank || bankAccounts.length === 0}
          >
            {pending ? "Processing…" : "Confirm payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AwaitingApproverBadge({ claim }: { claim: ClaimRecord }) {
  // Only show for SUBMITTED/PENDING claims that have a known next approver.
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

/** Small pill that distinguishes Mileage claims from regular Expense claims.
 *  Mileage gets a tertiary-tinted pill + Car icon so it stands out at a glance;
 *  Expense uses a muted style so it stays out of the way (it's the default). */
function ClaimTypeBadge({ claimType }: { claimType: ClaimType }) {
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

function PaymentTypeBadge({ claim }: { claim: ClaimRecord }) {
  const isCompany = claim.paymentType === "COMPANY"
  return (
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
  )
}

function ApprovalChainList({ chain }: { chain: ApprovalStepInfo[] }) {
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
            key={step.step}
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
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {step.state === "approved" && "Approved"}
              {step.state === "current" && "Pending"}
              {step.state === "upcoming" && "Upcoming"}
              {step.state === "rejected" && "Rejected"}
              {step.state === "skipped" && "Skipped"}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ClaimDetailSheet({
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
                <ClaimStatusBadge status={claim.status} />
                <ClaimTypeBadge claimType={claim.claimType} />
                <PaymentTypeBadge claim={claim} />
                <AwaitingApproverBadge claim={claim} />
              </div>
            </SheetHeader>

            <div className="mt-6 space-y-6 pb-2">
              {/* Core info */}
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

                {claim.payViaAccount ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      {claim.paymentType === "COMPANY" ? "Paid from" : "Paid via"}
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {claim.payViaAccount.code} · {claim.payViaAccount.name}
                    </p>
                  </div>
                ) : null}

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

              {/* Employee details */}
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

              {/* Approval chain */}
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

              {/* Receipt */}
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
                      {/* Show as image if it looks like one, otherwise as a link card. */}
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

export function AdminClaimsTable({
  claims,
  bankAccounts,
}: {
  claims: ClaimRecord[]
  bankAccounts: ChartOfAccountOption[]
}) {
  const [status, setStatus] = useState<ClaimStatus | "ALL">("ALL")
  // Distinguishes EXPENSE vs MILEAGE claims. "ALL" shows both. The table now
  // surfaces both types together, so admins typically want to narrow.
  const [typeFilter, setTypeFilter] = useState<ClaimType | "ALL">("ALL")
  const [searchTerm, setSearchTerm] = useState("")
  const [page, setPage] = useState(1)
  const [payingClaim, setPayingClaim] = useState<ClaimRecord | null>(null)
  const [detailClaim, setDetailClaim] = useState<ClaimRecord | null>(null)

  const filteredClaims = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return claims.filter((claim) => {
      const matchesStatus = claimMatchesStatusFilter(claim, status)
      const matchesType = typeFilter === "ALL" || claim.claimType === typeFilter

      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : [
              claim.claimNumber,
              claim.title,
              claim.employee.name,
              claim.employee.jobTitle,
              claim.chartOfAccount?.code,
              claim.chartOfAccount?.name,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery)

      return matchesStatus && matchesType && matchesQuery
    })
  }, [claims, searchTerm, status, typeFilter])

  useEffect(() => {
    setPage(1)
  }, [searchTerm, status, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filteredClaims.length / PAGE_SIZE))

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const paginatedClaims = useMemo(() => {
    const startIndex = (page - 1) * PAGE_SIZE
    return filteredClaims.slice(startIndex, startIndex + PAGE_SIZE)
  }, [filteredClaims, page])

  const hasActiveFilters =
    status !== "ALL" || typeFilter !== "ALL" || searchTerm.trim().length > 0

  const typeFilterOptions: Array<{ value: ClaimType | "ALL"; label: string }> = [
    { value: "ALL", label: "All types" },
    { value: "EXPENSE", label: "Expense" },
    { value: "MILEAGE", label: "Mileage" },
  ]

  return (
    <>
      {payingClaim ? (
        <PayDialog
          claim={payingClaim}
          bankAccounts={bankAccounts}
          open={true}
          onClose={() => setPayingClaim(null)}
        />
      ) : null}

      <ClaimDetailSheet
        claim={detailClaim}
        open={detailClaim !== null}
        onClose={() => setDetailClaim(null)}
      />

      <div className="space-y-4 sm:space-y-6">
        <Card>
          <CardContent className="space-y-4 px-5 pb-5 pt-3 sm:space-y-5 sm:p-6">
            <div className="hidden items-center justify-between gap-4 md:flex">
              <div className="relative w-full max-w-sm">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search by claim, employee, or account"
                  className="pl-10"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={status === "ALL" ? "default" : "ghost"}
                  onClick={() => setStatus("ALL")}
                  className={cn(
                    "rounded-full",
                    status !== "ALL" &&
                      "bg-surface-low text-muted-foreground hover:bg-surface-high hover:text-foreground"
                  )}
                >
                  All
                </Button>
                {visibleStatusOptions.map((claimStatus) => (
                  <Button
                    key={claimStatus}
                    type="button"
                    size="sm"
                    variant={status === claimStatus ? "default" : "ghost"}
                    onClick={() => setStatus(claimStatus)}
                    className={cn(
                      "rounded-full",
                      status !== claimStatus &&
                        "bg-surface-low text-muted-foreground hover:bg-surface-high hover:text-foreground"
                    )}
                  >
                    {statusLabels[claimStatus]}
                  </Button>
                ))}
              </div>
            </div>

            {/* Claim type filter (desktop) — separate row from status pills so
                the two concerns stay visually distinct. */}
            <div className="hidden flex-wrap items-center gap-2 md:flex">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Type
              </p>
              {typeFilterOptions.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={typeFilter === option.value ? "default" : "ghost"}
                  onClick={() => setTypeFilter(option.value)}
                  className={cn(
                    "rounded-full",
                    typeFilter !== option.value &&
                      "bg-surface-low text-muted-foreground hover:bg-surface-high hover:text-foreground"
                  )}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2 md:hidden">
              <button
                type="button"
                onClick={() => setStatus("ALL")}
                className={cn(
                  "relative z-10 touch-manipulation rounded-[20px] px-4 py-3 text-sm font-semibold transition-all sm:text-base",
                  status === "ALL"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                )}
              >
                All
              </button>
              {visibleStatusOptions.map((claimStatus) => (
                <button
                  key={claimStatus}
                  type="button"
                  onClick={() => setStatus(claimStatus)}
                  className={cn(
                    "relative z-10 touch-manipulation rounded-[20px] px-4 py-3 text-sm font-semibold transition-all sm:text-base",
                    status === claimStatus
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                  )}
                >
                  {statusLabels[claimStatus]}
                </button>
              ))}
            </div>

            {/* Claim type filter (mobile) — compact 3-up grid below the status
                row to mirror the desktop layout. */}
            <div className="grid grid-cols-3 gap-2 md:hidden">
              {typeFilterOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTypeFilter(option.value)}
                  className={cn(
                    "relative z-10 touch-manipulation rounded-[20px] px-4 py-2.5 text-xs font-semibold transition-all sm:text-sm",
                    typeFilter === option.value
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="md:hidden">
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search claims"
                  className="pl-10"
                />
              </div>
            </div>

            <div className="hidden flex-col gap-2 text-sm text-muted-foreground md:flex md:flex-row md:items-center md:justify-between">
              <p>
                Showing <span className="font-semibold text-foreground">{filteredClaims.length}</span>{" "}
                of <span className="font-semibold text-foreground">{claims.length}</span> claims
              </p>
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-fit rounded-full"
                  onClick={() => {
                    setStatus("ALL")
                    setTypeFilter("ALL")
                    setSearchTerm("")
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="px-1 text-sm text-muted-foreground md:hidden">
          <p>
            Showing <span className="font-semibold text-foreground">{filteredClaims.length}</span> of{" "}
            <span className="font-semibold text-foreground">{claims.length}</span> claims
          </p>
        </div>

        {filteredClaims.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground sm:p-8">
              No claims match the selected filters.
            </CardContent>
          </Card>
        ) : null}

        {/* Mobile cards */}
        {filteredClaims.length > 0 ? (
          <div className="grid gap-3 sm:gap-4 md:hidden">
            {paginatedClaims.map((claim) => (
              <Card
                key={claim.id}
                role="button"
                tabIndex={0}
                onClick={() => setDetailClaim(claim)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setDetailClaim(claim)
                  }
                }}
                className="cursor-pointer transition-colors hover:bg-surface-low/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <CardContent className="space-y-3 p-4 sm:space-y-4 sm:p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                        {claim.claimNumber}
                      </p>
                      <p className="mt-1 text-base font-black sm:text-lg">{claim.title}</p>
                      <p className="text-xs text-muted-foreground sm:text-sm">
                        {claim.employee.name} · {claim.employee.jobTitle}
                      </p>
                      <div className="mt-2">
                        <ClaimTypeBadge claimType={claim.claimType} />
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <ClaimStatusBadge status={claim.status} />
                      <PaymentTypeBadge claim={claim} />
                      <AwaitingApproverBadge claim={claim} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                        Submitted
                      </p>
                      <p className="mt-1 text-sm font-semibold sm:text-base">
                        {formatShortDate(claim.submittedAt)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                        Amount
                      </p>
                      <p className="mt-1 text-sm font-semibold sm:text-base">
                        {formatCurrency(claim.amount)}
                      </p>
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                      Chart of account
                    </p>
                    <p className="mt-1 text-sm font-semibold sm:text-base">
                      {claim.chartOfAccount
                        ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                        : "Not assigned"}
                    </p>
                  </div>
                  {claim.status === "PAID" && claim.payViaAccount ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                        Paid via
                      </p>
                      <p className="mt-1 text-sm font-semibold sm:text-base">
                        {claim.payViaAccount.code} · {claim.payViaAccount.name}
                      </p>
                    </div>
                  ) : null}
                  {claim.status === "APPROVED" && claim.paymentType === "PERSONAL" ? (
                    <Button
                      size="sm"
                      className="w-full gap-2 rounded-full"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPayingClaim(claim)
                      }}
                    >
                      <Banknote className="h-4 w-4" />
                      Mark as paid
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}

        {/* Desktop table */}
        {filteredClaims.length > 0 ? (
          <Card className="hidden md:block">
            <CardContent className="space-y-4 p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Claim</TableHead>
                    <TableHead>Chart of account</TableHead>
                    <TableHead className="whitespace-nowrap">Submitted</TableHead>
                    <TableHead className="whitespace-nowrap">Amount</TableHead>
                    <TableHead className="whitespace-nowrap">Paid by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedClaims.map((claim) => (
                    <TableRow
                      key={claim.id}
                      onClick={() => setDetailClaim(claim)}
                      className="cursor-pointer transition-colors hover:bg-surface-low/60"
                    >
                      <TableCell>
                        <div>
                          <p className="font-bold">{claim.employee.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {claim.employee.jobTitle}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                            {claim.claimNumber}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <p className="font-bold">{claim.title}</p>
                            <ClaimTypeBadge claimType={claim.claimType} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {claim.chartOfAccount
                          ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                          : "Not assigned"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatShortDate(claim.submittedAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-semibold">
                        {formatCurrency(claim.amount)}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <PaymentTypeBadge claim={claim} />
                          {claim.payViaAccount ? (
                            <p className="text-xs text-muted-foreground">
                              {claim.paymentType === "COMPANY" ? "from" : "via"}{" "}
                              {claim.payViaAccount.code} · {claim.payViaAccount.name}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ClaimStatusBadge status={claim.status} />
                          <AwaitingApproverBadge claim={claim} />
                        </div>
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap">
                        {claim.status === "APPROVED" && claim.paymentType === "PERSONAL" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 rounded-full"
                            onClick={(e) => {
                              e.stopPropagation()
                              setPayingClaim(claim)
                            }}
                          >
                            <Banknote className="h-3.5 w-3.5" />
                            Pay
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <PaginationControls
                className="flex flex-col gap-3 px-5 pb-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-6"
                currentPage={page}
                pageSize={PAGE_SIZE}
                totalItems={filteredClaims.length}
                itemLabel="claims"
                onPageChange={setPage}
              />
            </CardContent>
          </Card>
        ) : null}

        {filteredClaims.length > 0 ? (
          <div className="md:hidden">
            <PaginationControls
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              currentPage={page}
              pageSize={PAGE_SIZE}
              totalItems={filteredClaims.length}
              itemLabel="claims"
              onPageChange={setPage}
            />
          </div>
        ) : null}
      </div>
    </>
  )
}
