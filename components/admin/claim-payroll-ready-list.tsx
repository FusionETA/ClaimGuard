"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { CalendarPlus, CircleCheck, Loader2, Search } from "lucide-react"

import { attachClaimToPayrollRunAction } from "@/app/(admin)/admin/payroll/runs/actions"
import {
  ClaimDetailSheet,
  ClaimTypeBadge,
  OverLimitBadge,
  PaymentTypeBadge,
} from "@/components/admin/claim-row-helpers"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
import type { PayrollRunRow } from "@/modules/payroll/domain/runs"

const PAGE_SIZE = 10

/**
 * Admin "Ready for payroll" page. Lists REVIEWED + PERSONAL-paid
 * claims that haven't been attached to a payroll run yet. From each
 * row, the admin picks a draft run and clicks "Add" — the claim
 * disappears from this list and shows up under that run's
 * Reimbursements card.
 *
 * Replaces the previous "Ready to sync" view, which used to push
 * claims to Xero directly. Xero sync has moved to a post-submit,
 * module-gated step.
 */
export function ClaimPayrollReadyList({
  claims,
  draftRuns,
}: {
  claims: ClaimRecord[]
  draftRuns: PayrollRunRow[]
}) {
  const [typeFilter, setTypeFilter] = useState<ClaimType | "ALL">("ALL")
  const [searchTerm, setSearchTerm] = useState("")
  const [page, setPage] = useState(1)
  const [detailClaim, setDetailClaim] = useState<ClaimRecord | null>(null)

  const filteredClaims = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()
    return claims.filter((claim) => {
      const matchesType =
        typeFilter === "ALL" || claim.claimType === typeFilter
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : [
              claim.claimNumber,
              claim.title,
              claim.employee.name,
              claim.employee.jobTitle,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery)
      return matchesType && matchesQuery
    })
  }, [claims, searchTerm, typeFilter])

  // Reset paging when the filter set changes; otherwise the admin
  // can land on an empty page after typing a query.
  useEffect(() => {
    setPage(1)
  }, [searchTerm, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filteredClaims.length / PAGE_SIZE))

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const paginatedClaims = useMemo(() => {
    const startIndex = (page - 1) * PAGE_SIZE
    return filteredClaims.slice(startIndex, startIndex + PAGE_SIZE)
  }, [filteredClaims, page])

  const hasActiveFilters =
    typeFilter !== "ALL" || searchTerm.trim().length > 0

  const typeFilterOptions: Array<{
    value: ClaimType | "ALL"
    label: string
  }> = [
    { value: "ALL", label: "All types" },
    { value: "EXPENSE", label: "Expense" },
    { value: "MILEAGE", label: "Mileage" },
  ]

  // ── Empty state — no claims at all
  if (claims.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-10 text-center">
          <CircleCheck className="h-8 w-8 text-emerald-500" />
          <p className="font-semibold">All caught up</p>
          <p className="text-sm text-muted-foreground">
            No reviewed claims are waiting for payroll. Approved
            claims will appear here once an admin reviews them.
          </p>
        </CardContent>
      </Card>
    )
  }

  // ── Empty state — no draft runs to attach to (still show the list
  //    so the admin can see what's waiting + understand why action is
  //    blocked)
  const noDraftRuns = draftRuns.length === 0

  return (
    <>
      <ClaimDetailSheet
        claim={detailClaim}
        open={detailClaim !== null}
        onClose={() => setDetailClaim(null)}
      />

      <div className="space-y-4 sm:space-y-6">
        <Card>
          <CardContent className="space-y-4 px-5 pb-5 pt-3 sm:space-y-5 sm:p-6">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by claim or employee"
                className="pl-10"
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
              <Select
                value={typeFilter}
                onValueChange={(value) =>
                  setTypeFilter(value as ClaimType | "ALL")
                }
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
                Showing{" "}
                <span className="font-semibold text-foreground">
                  {filteredClaims.length}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-foreground">
                  {claims.length}
                </span>{" "}
                claims
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

        {/* Heads-up when there are no draft payroll runs — admin
            won't be able to attach until they start a new run. */}
        {noDraftRuns ? (
          <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
            <CardContent className="p-4 text-sm text-amber-900 dark:text-amber-200">
              No draft payroll run yet. Create a new run from{" "}
              <a
                href="/admin/payroll/runs"
                className="underline-offset-2 hover:underline"
              >
                Payroll → Runs
              </a>{" "}
              before attaching claims.
            </CardContent>
          </Card>
        ) : null}

        {filteredClaims.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              No claims match your search.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Claim</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedClaims.map((claim) => (
                    <ClaimRow
                      key={claim.id}
                      claim={claim}
                      draftRuns={draftRuns}
                      onOpen={() => setDetailClaim(claim)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            <PaginationControls
              currentPage={page}
              pageSize={PAGE_SIZE}
              totalItems={filteredClaims.length}
              itemLabel="claims"
              onPageChange={setPage}
            />
          </Card>
        )}
      </div>
    </>
  )
}

/**
 * One row of the table. Renders the claim summary + a small
 * inline form: pick a draft run, click "Add". On success the page
 * revalidates and this row disappears from the list (it now lives
 * under the chosen run's Reimbursements card).
 */
function ClaimRow({
  claim,
  draftRuns,
  onOpen,
}: {
  claim: ClaimRecord
  draftRuns: PayrollRunRow[]
  onOpen: () => void
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  // Default the picker to the most-recent draft run (the list is
  // already sorted newest-first by year/month from the repository).
  const [selectedRunId, setSelectedRunId] = useState<string>(
    draftRuns[0]?.id ?? "",
  )

  function handleAttach() {
    if (!selectedRunId) {
      toast({ title: "Pick a draft payroll run first.", variant: "error" })
      return
    }
    const fd = new FormData()
    fd.set("runId", selectedRunId)
    fd.set("claimId", claim.id)
    startTransition(async () => {
      const result = await attachClaimToPayrollRunAction(
        { status: "idle", message: "" },
        fd,
      )
      if (result.status === "success") {
        toast({
          title: `Added "${claim.title}" to ${runLabel(
            draftRuns.find((r) => r.id === selectedRunId)!,
          )}.`,
          variant: "success",
        })
      } else if (result.status === "error") {
        toast({
          title: result.message,
          variant: "error",
        })
      }
    })
  }

  return (
    <TableRow
      className="cursor-pointer"
      onClick={(e) => {
        // Don't open the detail sheet when the click came from the
        // run picker or the Add button inside this row.
        const target = e.target as HTMLElement
        if (target.closest("[data-row-action]")) return
        onOpen()
      }}
    >
      <TableCell className="font-medium">
        <div className="flex flex-col">
          <span>{claim.title}</span>
          <span className="text-[10px] text-muted-foreground">
            {claim.claimNumber}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          <span>{claim.employee.name}</span>
          <span className="text-[10px] text-muted-foreground">
            {claim.employee.jobTitle}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {claim.spentAt ? formatShortDate(claim.spentAt) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <ClaimTypeBadge claimType={claim.claimType} />
          <PaymentTypeBadge claim={claim} />
          {claim.exceedsLimit ? <OverLimitBadge /> : null}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono">
        {formatCurrency(claim.amount)}
      </TableCell>
      <TableCell className="text-right">
        <div
          data-row-action
          className="flex items-center justify-end gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Select value={selectedRunId} onValueChange={setSelectedRunId}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue placeholder="Pick a draft run" />
            </SelectTrigger>
            <SelectContent>
              {draftRuns.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {runLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={pending || draftRuns.length === 0 || !selectedRunId}
            onClick={handleAttach}
            className="gap-1.5"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CalendarPlus className="h-3.5 w-3.5" />
            )}
            Add
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

/** Human-readable label for a payroll run row, e.g. "March 2026". */
function runLabel(run: PayrollRunRow): string {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  return `${monthNames[run.periodMonth - 1]} ${run.periodYear}`
}
