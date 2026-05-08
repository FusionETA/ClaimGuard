"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { CircleCheck, Loader2, Search, Sparkles, X } from "lucide-react"

import {
  syncClaimAction,
  syncClaimsBulkAction,
} from "@/app/(admin)/admin/claims/actions"
import {
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
import { useToast } from "@/components/ui/toaster"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import type { ClaimRecord, ClaimType } from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

const PAGE_SIZE = 10

/**
 * Admin "Ready to sync" page. Mirrors the layout of `AdminClaimsTable`
 * (queue) so admins get a consistent search + filter + table experience
 * across both Claims views. Differences from the queue table:
 *
 *   - Status filter is gone — every row is REVIEWED + NOT_SYNCED by
 *     definition.
 *   - Reviewer filter is gone — same reason.
 *   - The per-row action is "Sync" (opens a dialog with the COA picker
 *     + a confirm button) instead of "Review".
 *
 * Click any row to open the standard ClaimDetailSheet shared with the
 * queue.
 */
export function ClaimSyncList({
  claims,
  chartAccounts,
}: {
  claims: ClaimRecord[]
  chartAccounts: ChartOfAccountOption[]
}) {
  const [typeFilter, setTypeFilter] = useState<ClaimType | "ALL">("ALL")
  const [searchTerm, setSearchTerm] = useState("")
  const [page, setPage] = useState(1)
  const [syncingClaim, setSyncingClaim] = useState<ClaimRecord | null>(null)
  const [detailClaim, setDetailClaim] = useState<ClaimRecord | null>(null)
  // IDs of claims the admin has ticked for a bulk sync. Stored as a Set
  // so toggling is O(1). Cleared whenever the input list changes (after
  // a server revalidation rerenders the page with fewer claims, the old
  // ids are stale and we want a clean slate).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Toggles the bulk-sync confirm dialog.
  const [bulkOpen, setBulkOpen] = useState(false)

  const filteredClaims = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return claims.filter((claim) => {
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

      return matchesType && matchesQuery
    })
  }, [claims, searchTerm, typeFilter])

  // Reset paging when the filter set changes; otherwise the admin can land
  // on an empty page after typing a query.
  useEffect(() => {
    setPage(1)
  }, [searchTerm, typeFilter])

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
    typeFilter !== "ALL" || searchTerm.trim().length > 0

  // After a successful bulk-sync the page revalidates with fewer claims;
  // any selectedIds that no longer exist would be dead state. Prune
  // selection to the current claim set so the bulk action bar count
  // never exaggerates.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const live = new Set<string>()
      for (const claim of claims) {
        if (prev.has(claim.id)) live.add(claim.id)
      }
      // Reference equality preserved when no change → no rerender churn.
      return live.size === prev.size ? prev : live
    })
  }, [claims])

  // Helpers for selection toggling + summary stats. `selectedClaims` is
  // the ordered list (table-order) of selected rows; the bulk dialog
  // uses it for the summary table and to hand ids to the server action.
  const selectedClaims = useMemo(
    () => claims.filter((c) => selectedIds.has(c.id)),
    [claims, selectedIds],
  )
  const selectedTotalAmount = useMemo(
    () => selectedClaims.reduce((sum, c) => sum + (c.amount ?? 0), 0),
    [selectedClaims],
  )

  function toggleOne(claimId: string, value: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (value) {
        next.add(claimId)
      } else {
        next.delete(claimId)
      }
      return next
    })
  }

  // "Select all" applies only to claims VISIBLE on the current filter +
  // page. This matches the way other table-with-bulk-actions UIs behave
  // (Gmail, GitHub) — clicking the header tick adds/removes the page,
  // not the whole filtered set behind it. Admins paginating through a
  // 200-row queue can still build up a multi-page selection by ticking
  // the header on each page.
  const visibleSelectedCount = paginatedClaims.filter((c) =>
    selectedIds.has(c.id),
  ).length
  const allVisibleSelected =
    paginatedClaims.length > 0 &&
    visibleSelectedCount === paginatedClaims.length

  function toggleAllVisible(value: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const claim of paginatedClaims) {
        if (value) next.add(claim.id)
        else next.delete(claim.id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  const typeFilterOptions: Array<{ value: ClaimType | "ALL"; label: string }> = [
    { value: "ALL", label: "All types" },
    { value: "EXPENSE", label: "Expense" },
    { value: "MILEAGE", label: "Mileage" },
  ]

  // Empty state — shown once when there are zero awaiting-sync claims at
  // all (i.e. the page just loaded and the queue is empty). The
  // filter-driven empty state below is separate so we can keep the
  // search/filter card visible even when current filters return nothing.
  if (claims.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-10 text-center">
          <CircleCheck className="h-8 w-8 text-emerald-500" />
          <p className="font-semibold">All caught up</p>
          <p className="text-sm text-muted-foreground">
            No claims are waiting to be synced. Reviewed claims will appear
            here once an admin approves them.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      {syncingClaim ? (
        <SyncClaimDialog
          claim={syncingClaim}
          chartAccounts={chartAccounts}
          open={true}
          onClose={() => setSyncingClaim(null)}
        />
      ) : null}

      <ClaimDetailSheet
        claim={detailClaim}
        open={detailClaim !== null}
        onClose={() => setDetailClaim(null)}
      />

      <BulkSyncDialog
        claims={selectedClaims}
        totalAmount={selectedTotalAmount}
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onSuccess={() => {
          setBulkOpen(false)
          // Selection of synced rows is pruned automatically by the
          // useEffect above once the server revalidation lands. Failed
          // rows stay selected so the admin can retry.
        }}
      />

      <div className="space-y-4 sm:space-y-6">
        <Card>
          <CardContent className="space-y-4 px-5 pb-5 pt-3 sm:space-y-5 sm:p-6">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by claim, employee, or account"
                className="pl-10"
              />
            </div>

            {/* Single dropdown — only the claim-type filter applies here.
                Status / reviewer filters from the queue are dropped because
                every row in this view has the same status by construction. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
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

        {/* Bulk action bar — appears once at least one row is ticked.
            Sits between the filter card and the result list so it stays
            in the same visual lane regardless of mobile/desktop. Total
            amount is approximate when claims span multiple currencies
            (we don't FX-convert at this stage), so the formatter just
            prints the raw sum with the org default. */}
        {selectedIds.size > 0 ? (
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <p className="font-bold text-foreground">
                  {selectedIds.size} selected
                </p>
                <p className="text-xs text-muted-foreground">
                  Total {formatCurrency(selectedTotalAmount)} · syncs each row
                  with its current chart of account. To recode a row, sync
                  it individually.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearSelection}
                  className="rounded-full"
                >
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setBulkOpen(true)}
                  className="gap-1.5 rounded-full"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Sync {selectedIds.size}{" "}
                  {selectedIds.size === 1 ? "claim" : "claims"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {filteredClaims.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground sm:p-8">
              No claims match the selected filters.
            </CardContent>
          </Card>
        ) : null}

        {/* Mobile cards — same shape as the queue's mobile rendering, with
            "Sync" replacing "Review" as the row action. */}
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
                    <div className="flex min-w-0 items-start gap-3">
                      {/* Stop propagation so ticking the box doesn't open the
                          detail sheet (the parent Card is role="button"). */}
                      <input
                        type="checkbox"
                        aria-label={`Select claim ${claim.claimNumber}`}
                        checked={selectedIds.has(claim.id)}
                        onChange={(e) => toggleOne(claim.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                      />
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
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <PaymentTypeBadge claim={claim} align="end" />
                      {claim.exceedsLimit ? <OverLimitBadge /> : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                        Spent on
                      </p>
                      <p className="mt-1 text-sm font-semibold sm:text-base">
                        {formatShortDate(claim.spentAt)}
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
                  <Button
                    size="sm"
                    className="w-full gap-2 rounded-full"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSyncingClaim(claim)
                    }}
                  >
                    <Sparkles className="h-4 w-4" />
                    Sync to Xero
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}

        {/* Desktop table — same column layout as the queue, minus the
            Status column (always REVIEWED here). */}
        {filteredClaims.length > 0 ? (
          <Card className="hidden md:block">
            <CardContent className="space-y-4 p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    {/* Master checkbox — toggles selection on the current
                        page's rows only. Multi-page selection accrues by
                        ticking the header on each page (Gmail / GitHub
                        behaviour). */}
                    <TableHead className="w-px">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={allVisibleSelected}
                        onChange={(e) => toggleAllVisible(e.target.checked)}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                    </TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Claim</TableHead>
                    <TableHead>Chart of account</TableHead>
                    <TableHead className="whitespace-nowrap">Spent on</TableHead>
                    <TableHead className="whitespace-nowrap">Amount</TableHead>
                    <TableHead className="whitespace-nowrap">Paid by</TableHead>
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
                      <TableCell
                        className="w-px"
                        // Stop the row click from opening the detail sheet
                        // when the user clicks INSIDE the checkbox cell.
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select claim ${claim.claimNumber}`}
                          checked={selectedIds.has(claim.id)}
                          onChange={(e) => toggleOne(claim.id, e.target.checked)}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </TableCell>
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
                            {claim.exceedsLimit ? <OverLimitBadge /> : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {claim.chartOfAccount
                          ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                          : "Not assigned"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatShortDate(claim.spentAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-semibold">
                        {formatCurrency(claim.amount)}
                      </TableCell>
                      <TableCell>
                        <PaymentTypeBadge claim={claim} />
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap">
                        <Button
                          size="sm"
                          className="gap-1.5 rounded-full"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSyncingClaim(claim)
                          }}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          Sync
                        </Button>
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

/**
 * Small dialog for the per-row Sync action: shows a claim summary, lets
 * the admin recode the chart of account one last time, then submits.
 * Replaces the old fat per-row Card+Select+Button layout so the table
 * itself can stay tidy. Mirrors the queue's `AdminFinalApprovalDialog`
 * style for consistency.
 */
function SyncClaimDialog({
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
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  // Pre-select whatever the claim is currently coded as. Admin only needs
  // to act if they're swapping it; otherwise hitting Sync is a no-op recode.
  const [coaId, setCoaId] = useState<string>(claim.chartOfAccount?.id ?? "")

  function handleSync() {
    startTransition(async () => {
      const finalCoa =
        coaId && coaId !== claim.chartOfAccount?.id ? coaId : undefined
      const result = await syncClaimAction({
        claimId: claim.id,
        chartOfAccountId: finalCoa,
      })
      if (result.ok) {
        toast({ title: result.message, variant: "success" })
        onClose()
      } else {
        toast({ title: result.message, variant: "error" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="w-[min(92vw,520px)] sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Sync claim to Xero</DialogTitle>
          <DialogDescription>
            Last chance to swap the chart of account. The claim is pushed
            with whatever&rsquo;s selected here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-xl border border-border/70 bg-surface-low p-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {claim.claimNumber}
            </p>
            <p className="mt-1 font-bold">{claim.title}</p>
            <p className="mt-0.5 text-muted-foreground">
              {claim.employee.name} · {claim.employee.jobTitle}
            </p>
            <p className="mt-2 text-lg font-black tabular-nums">
              {formatCurrency(claim.amount)}{" "}
              <span className="text-xs font-medium text-muted-foreground">
                {claim.currency}
              </span>
            </p>
            {claim.reviewerName ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Reviewed by {claim.reviewerName}
                {claim.reviewedAt ? ` on ${formatShortDate(claim.reviewedAt)}` : ""}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>Chart of account</Label>
            {chartAccounts.length === 0 ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                No selectable accounts configured. Add one in Settings →
                Accounts before syncing.
              </p>
            ) : (
              <Select value={coaId} onValueChange={setCoaId} disabled={pending}>
                <SelectTrigger>
                  <SelectValue placeholder="Select chart of account" />
                </SelectTrigger>
                <SelectContent>
                  {chartAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.code} · {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {claim.chartOfAccount && coaId && coaId !== claim.chartOfAccount.id ? (
              <p className="text-xs text-amber-700">
                Will be recoded from{" "}
                <span className="font-semibold">
                  {claim.chartOfAccount.code} · {claim.chartOfAccount.name}
                </span>
              </p>
            ) : null}
          </div>
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
            type="button"
            onClick={handleSync}
            disabled={pending || !coaId || chartAccounts.length === 0}
            className="rounded-xl"
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Sync to Xero
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Confirm dialog for bulk sync. Shows a small breakdown of which claims
 * will be pushed (claim number + employee + amount) so the admin can
 * eyeball the list before committing. Submits the full id array to
 * `syncClaimsBulkAction` and reports per-row failures via toast if any.
 *
 * Bulk mode intentionally has NO COA picker — every claim syncs with
 * whatever it's currently coded as. Admins who need to recode a
 * specific row should sync it individually first.
 */
function BulkSyncDialog({
  claims,
  totalAmount,
  open,
  onClose,
  onSuccess,
}: {
  claims: ClaimRecord[]
  totalAmount: number
  open: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()

  function handleSync() {
    if (claims.length === 0) return
    startTransition(async () => {
      const result = await syncClaimsBulkAction({
        claimIds: claims.map((c) => c.id),
      })
      // Toast variant set is just "success" | "error" — there's no
      // dedicated warning. For partial success we still flag it as
      // "success" because the headline message itself ("Synced 3 of 5
      // — 2 failed") makes the partial nature obvious; the specific
      // failure messages then come through as "error" toasts below.
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
      // Surface the first couple of specific failure messages so the
      // admin sees WHY (missing COA, no Xero connection, etc) without
      // having to dig in the console.
      for (const failure of result.failures.slice(0, 3)) {
        const claim = claims.find((c) => c.id === failure.claimId)
        toast({
          title: claim
            ? `${claim.claimNumber}: ${failure.message}`
            : failure.message,
          variant: "error",
        })
      }
      if (result.ok) {
        onSuccess()
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="w-[min(92vw,560px)] sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            Sync {claims.length} {claims.length === 1 ? "claim" : "claims"} to Xero
          </DialogTitle>
          <DialogDescription>
            Each row syncs with its current chart of account. Rows that fail
            (missing COA, Xero error, etc.) stay in the list so you can
            retry — successful rows disappear once the page reloads.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Summary block */}
          <div className="rounded-xl border border-border/70 bg-surface-low p-4 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Total
                </p>
                <p className="mt-1 text-lg font-black tabular-nums">
                  {formatCurrency(totalAmount)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {claims.length} {claims.length === 1 ? "claim" : "claims"}
              </p>
            </div>
          </div>

          {/* Per-row preview — capped at 8 with an "and N more" line so
              very large selections don't blow out the dialog height. */}
          <div className="space-y-1.5 rounded-xl border border-border/60 bg-card p-2 text-sm">
            <ul className="max-h-60 space-y-1 overflow-y-auto pr-1">
              {claims.slice(0, 8).map((claim) => (
                <li
                  key={claim.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-surface-low"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      {claim.claimNumber}
                    </p>
                    <p className="truncate font-semibold">{claim.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {claim.employee.name}
                      {claim.chartOfAccount
                        ? ` · ${claim.chartOfAccount.code}`
                        : " · No account"}
                    </p>
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums">
                    {formatCurrency(claim.amount)}
                  </p>
                </li>
              ))}
            </ul>
            {claims.length > 8 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                …and {claims.length - 8} more
              </p>
            ) : null}
          </div>
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
            type="button"
            onClick={handleSync}
            disabled={pending || claims.length === 0}
            className="rounded-xl"
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Syncing {claims.length}…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Sync {claims.length} to Xero
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
