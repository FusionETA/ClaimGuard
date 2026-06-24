"use client"

import {
  useActionState,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, Loader2, Search } from "lucide-react"

import {
  adminFinalReviewClaimAction,
  updateClaimChartOfAccountAction,
} from "@/app/(admin)/admin/claims/actions"
import { createInitialReviewClaimFormState } from "@/app/(admin)/admin/claims/form-state"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import {
  AwaitingApproverBadge,
  ClaimDetailSheet,
  ClaimTypeBadge,
  OverLimitBadge,
  PaymentTypeBadge,
} from "@/components/admin/claim-row-helpers"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useToast, useToastOnAction } from "@/components/ui/toaster"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import {
  claimMatchesReviewerFilter,
  claimMatchesStatusFilter,
  visibleStatusOptions,
  type ClaimRecord,
  type ClaimStatus,
  type ClaimType,
  type ReviewerFilter,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

const PAGE_SIZE = 10

const statusLabels: Record<ClaimStatus, string> = {
  SUBMITTED: "Pending",
  PENDING: "Pending",
  APPROVED: "Approved",
  REVIEWED: "Reviewed",
  REJECTED: "Rejected",
}

// `visibleStatusOptions` and the SUBMITTED-folds-into-PENDING rule live in
// the claims domain so the admin table, supervisor queue, and employee
// history can't drift apart.

/**
 * Admin's "Final approve" dialog. Opens for any claim with
 * `awaitingAdminFinalApproval === true` — i.e. all supervisors have signed
 * off (or the chain is empty) and the claim is ready for admin review. Admin can:
 *   1. Optionally swap the chart of account before approving.
 *   2. Add review notes.
 *   3. Approve → claim becomes REVIEWED (terminal).
 *   4. Reject → claim becomes REJECTED. Notes are required when rejecting.
 */
function AdminFinalApprovalDialog({
  claim,
  chartAccounts,
  open,
  onClose,
}: {
  claim: ClaimRecord
  chartAccounts: ChartOfAccountOption[]
  open: boolean
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(
    adminFinalReviewClaimAction,
    createInitialReviewClaimFormState()
  )

  const [reason, setReason] = useState("")
  // The decision is set by which submit button the admin clicks; both
  // buttons live in the same form so we toggle this hidden input value.
  const [pendingDecision, setPendingDecision] = useState<"APPROVED" | "REJECTED">("APPROVED")

  // ── Chart of Account editor ───────────────────────────────────────
  // Admins routinely need to recode a claim (e.g. employee picked the
  // wrong expense category) during the review window OR after it's
  // been marked reviewed but before payout/sync. Allowed for EXPENSE
  // claims at SUBMITTED/PENDING/APPROVED/REVIEWED — repo + service
  // enforce the same gates server-side.
  const router = useRouter()
  const { toast } = useToast()
  const isMileage = claim.claimType === "MILEAGE"
  const coaEditable =
    !isMileage &&
    chartAccounts.length > 0 &&
    (claim.status === "SUBMITTED" ||
      claim.status === "PENDING" ||
      claim.status === "APPROVED" ||
      claim.status === "REVIEWED")
  const [selectedCoaId, setSelectedCoaId] = useState<string>(
    claim.chartOfAccount?.id ?? "",
  )
  const [coaSaving, startCoaSave] = useTransition()
  const coaChanged =
    coaEditable && selectedCoaId !== (claim.chartOfAccount?.id ?? "")
  function handleCoaSave() {
    if (!selectedCoaId || !coaChanged) return
    startCoaSave(async () => {
      const result = await updateClaimChartOfAccountAction({
        claimId: claim.id,
        chartOfAccountId: selectedCoaId,
      })
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
      if (result.ok) router.refresh()
    })
  }

  // Reset local state when the dialog re-opens for a new claim.
  useEffect(() => {
    if (open) {
      setReason("")
      setPendingDecision("APPROVED")
      setSelectedCoaId(claim.chartOfAccount?.id ?? "")
    }
  }, [open, claim.id, claim.chartOfAccount?.id])

  useToastOnAction(state)

  // Close the dialog on a successful submission. Depend on the state
  // reference, not on state.status — see useToastOnAction for the
  // rationale. Without this, a second successful submission with the
  // same status wouldn't re-trigger close.
  useEffect(() => {
    if (state.status === "success") {
      onClose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, onClose])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="w-[min(92vw,520px)] sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Review claim</DialogTitle>
          <DialogDescription>
            Approve, reject, or recode this claim before payout.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Claim summary card */}
          <div className="rounded-xl border border-border/70 bg-surface-low p-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {claim.claimNumber}
            </p>
            <p className="mt-1 font-bold">{claim.title}</p>
            <p className="mt-0.5 text-muted-foreground">
              {claim.employee.name} · {claim.employee.jobTitle}
            </p>
            <p className="mt-2 text-lg font-black">{formatCurrency(claim.amount)}</p>
          </div>

          <form action={action} id="admin-final-form" className="space-y-4">
            <input type="hidden" name="claimId" value={claim.id} />
            <input type="hidden" name="decision" value={pendingDecision} />

            <div className="space-y-2">
              <Label>Chart of account (filed under)</Label>
              {coaEditable ? (
                <>
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedCoaId || undefined}
                      onValueChange={(v) => setSelectedCoaId(v)}
                      disabled={coaSaving}
                    >
                      <SelectTrigger className="h-10 flex-1">
                        <SelectValue placeholder="Pick a chart of account" />
                      </SelectTrigger>
                      <SelectContent>
                        {chartAccounts.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.code} · {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleCoaSave}
                      disabled={!coaChanged || coaSaving || !selectedCoaId}
                    >
                      {coaSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Recode now to fix coding mistakes before payout. Locked
                    once the claim is synced to Xero.
                  </p>
                </>
              ) : (
                <>
                  <div className="rounded-lg border border-border/60 bg-surface-low px-3 py-2 text-sm">
                    {claim.chartOfAccount ? (
                      <span className="font-semibold text-foreground">
                        {claim.chartOfAccount.code} · {claim.chartOfAccount.name}
                      </span>
                    ) : (
                      <span className="italic text-muted-foreground">
                        No account assigned
                      </span>
                    )}
                  </div>
                  {isMileage ? (
                    <p className="text-xs text-muted-foreground">
                      Mileage claims are coded at submission — the snapshot
                      rate is tied to this account.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Recoding is locked once the claim is rejected or synced
                      to Xero.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">
                Notes
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  (required to reject)
                </span>
              </Label>
              <Textarea
                id="reason"
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Optional note for approve, required if rejecting…"
                rows={3}
                disabled={pending}
              />
              {state.errors.reason ? (
                <p className="text-sm text-destructive">{state.errors.reason}</p>
              ) : null}
            </div>

            {state.status === "error" && !state.errors.reason ? (
              <p className="text-sm text-destructive">{state.message}</p>
            ) : null}
          </form>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="admin-final-form"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setPendingDecision("REJECTED")}
            disabled={pending || chartAccounts.length === 0}
          >
            {pending && pendingDecision === "REJECTED" ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Rejecting…</>
            ) : (
              "Reject"
            )}
          </Button>
          <Button
            type="submit"
            form="admin-final-form"
            onClick={() => setPendingDecision("APPROVED")}
            disabled={pending || chartAccounts.length === 0}
          >
            {pending && pendingDecision === "APPROVED" ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Reviewing…</>
            ) : (
              <><CheckCircle2 className="mr-2 h-4 w-4" />Mark reviewed</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AdminClaimsTable({
  claims,
  chartAccounts,
}: {
  claims: ClaimRecord[]
  /** Selectable chart accounts shown in the admin's "Final approve" dialog. */
  chartAccounts: ChartOfAccountOption[]
}) {
  const [status, setStatus] = useState<ClaimStatus | "ALL">("ALL")
  // Distinguishes EXPENSE vs MILEAGE claims. "ALL" shows both. The table now
  // surfaces both types together, so admins typically want to narrow.
  const [typeFilter, setTypeFilter] = useState<ClaimType | "ALL">("ALL")
  // Filters by who acted on the claim — supervisor vs admin. Independent of
  // status (so you can combine "Approved + by Supervisor", "Rejected + by
  // Admin", etc.). Pending/unreviewed claims only ever show under "All".
  const [reviewerFilter, setReviewerFilter] = useState<ReviewerFilter>("ALL")
  const [searchTerm, setSearchTerm] = useState("")
  const [page, setPage] = useState(1)
  // Claim currently open in the AdminFinalApprovalDialog, if any.
  const [reviewingClaim, setReviewingClaim] = useState<ClaimRecord | null>(null)
  const [detailClaim, setDetailClaim] = useState<ClaimRecord | null>(null)

  const filteredClaims = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return claims.filter((claim) => {
      const matchesStatus = claimMatchesStatusFilter(claim, status)
      const matchesType = typeFilter === "ALL" || claim.claimType === typeFilter
      const matchesReviewer = claimMatchesReviewerFilter(claim, reviewerFilter)

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

      return matchesStatus && matchesType && matchesReviewer && matchesQuery
    })
  }, [claims, searchTerm, status, typeFilter, reviewerFilter])

  useEffect(() => {
    setPage(1)
  }, [searchTerm, status, typeFilter, reviewerFilter])

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
    status !== "ALL" ||
    typeFilter !== "ALL" ||
    reviewerFilter !== "ALL" ||
    searchTerm.trim().length > 0

  const typeFilterOptions: Array<{ value: ClaimType | "ALL"; label: string }> = [
    { value: "ALL", label: "All types" },
    { value: "EXPENSE", label: "Expense" },
    { value: "MILEAGE", label: "Mileage" },
  ]

  const reviewerFilterOptions: Array<{ value: ReviewerFilter; label: string }> = [
    { value: "ALL", label: "All reviewers" },
    { value: "SUPERVISOR", label: "Supervisor" },
    { value: "ADMIN", label: "Admin" },
  ]

  return (
    <>
      {reviewingClaim ? (
        <AdminFinalApprovalDialog
          claim={reviewingClaim}
          chartAccounts={chartAccounts}
          open={true}
          onClose={() => setReviewingClaim(null)}
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
            {/* Search input — full width, same on mobile and desktop. */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by claim, employee, or account"
                className="pl-10"
              />
            </div>

            {/* Three filter dropdowns — same layout on mobile and desktop.
                Stack on the narrowest screens, then sit side-by-side from
                sm: upward. Dropdowns are far more compact than rows of pills
                and let admins combine filters (e.g. "Approved + Mileage +
                by Admin") with three taps. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as ClaimStatus | "ALL")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  {visibleStatusOptions.map((claimStatus) => (
                    <SelectItem key={claimStatus} value={claimStatus}>
                      {statusLabels[claimStatus]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={typeFilter}
                onValueChange={(value) => setTypeFilter(value as ClaimType | "ALL")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeFilterOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={reviewerFilter}
                onValueChange={(value) => setReviewerFilter(value as ReviewerFilter)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reviewerFilterOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
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
                    setReviewerFilter("ALL")
                    setSearchTerm("")
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

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
                      <ClaimStatusBadge status={claim.status} reviewerRole={claim.reviewerRole} />
                      <PaymentTypeBadge claim={claim} align="end" />
                      <AwaitingApproverBadge claim={claim} />
                      {claim.exceedsLimit ? <OverLimitBadge /> : null}
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
                  {claim.awaitingAdminFinalApproval ? (
                    <Button
                      size="sm"
                      className="w-full gap-2 rounded-full"
                      onClick={(e) => {
                        e.stopPropagation()
                        setReviewingClaim(claim)
                      }}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Review
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
                        <PaymentTypeBadge claim={claim} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ClaimStatusBadge status={claim.status} reviewerRole={claim.reviewerRole} />
                          <AwaitingApproverBadge claim={claim} />
                        </div>
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap">
                        {claim.awaitingAdminFinalApproval ? (
                          <Button
                            size="sm"
                            className="gap-1.5 rounded-full"
                            onClick={(e) => {
                              e.stopPropagation()
                              setReviewingClaim(claim)
                            }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Review
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
