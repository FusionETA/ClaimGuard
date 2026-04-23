"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"

import { ClaimCategoryIcon } from "@/components/claims/claim-category-icon"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { categoryMeta } from "@/modules/claims/domain/metadata"
import {
  claimStatuses,
  type ClaimRecord,
  type ClaimStatus,
} from "@/modules/claims/domain/models"
import { cn } from "@/lib/utils"
import { formatCurrency, formatShortDate } from "@/lib/utils"

type EmployeeClaimsHistoryProps = {
  claims: ClaimRecord[]
}

const statusLabels: Record<ClaimStatus, string> = {
  SUBMITTED: "Pending",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PAID: "Paid",
}

const visibleStatusOptions = claimStatuses.filter(
  (status) => status !== "SUBMITTED"
) as Exclude<ClaimStatus, "SUBMITTED">[]

export function EmployeeClaimsHistory({ claims }: EmployeeClaimsHistoryProps) {
  const [status, setStatus] = useState<ClaimStatus | "ALL">("ALL")
  const [searchTerm, setSearchTerm] = useState("")

  const filteredClaims = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return claims.filter((claim) => {
      const matchesStatus =
        status === "ALL"
          ? true
          : status === "PENDING"
            ? claim.status === "PENDING" || claim.status === "SUBMITTED"
            : claim.status === status

      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : [claim.claimNumber, claim.title, categoryMeta[claim.category].label]
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery)

      return matchesStatus && matchesQuery
    })
  }, [claims, searchTerm, status])

  const hasActiveFilters = status !== "ALL" || searchTerm.trim().length > 0

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card>
        <CardContent className="space-y-4 px-5 pb-5 pt-3 sm:space-y-5 sm:p-6">
          <div className="hidden items-center justify-between gap-4 md:flex">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by claim, title, or category"
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
            No claims match the selected status.
          </CardContent>
        </Card>
      ) : null}

      {filteredClaims.length > 0 ? (
        <div className="grid gap-3 sm:gap-4 md:hidden">
          {filteredClaims.map((claim) => (
            <Card key={claim.id}>
              <CardContent className="space-y-3 p-4 sm:space-y-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl bg-surface-low p-2.5 text-primary sm:rounded-2xl sm:p-3">
                      <ClaimCategoryIcon category={claim.category} className="h-4 w-4 sm:h-5 sm:w-5" />
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                        {claim.claimNumber}
                      </p>
                      <p className="mt-1 text-base font-black sm:text-lg">{claim.title}</p>
                      <p className="text-xs text-muted-foreground sm:text-sm">
                        {categoryMeta[claim.category].label}
                      </p>
                    </div>
                  </div>
                  <ClaimStatusBadge status={claim.status} />
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
                {claim.reviewNotes ? (
                  <div className="rounded-[20px] bg-surface-low p-3.5 sm:rounded-2xl sm:p-4">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                      Reviewer note
                    </p>
                    <p className="mt-2 text-xs leading-6 text-muted-foreground sm:text-sm">
                      {claim.reviewNotes}
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {filteredClaims.length > 0 ? (
        <Card className="hidden md:block">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredClaims.map((claim) => (
                  <TableRow key={claim.id}>
                    <TableCell>
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          {claim.claimNumber}
                        </p>
                        <p className="mt-1 font-bold">{claim.title}</p>
                        {claim.reviewNotes ? (
                          <p className="mt-2 text-sm text-muted-foreground">
                            Reviewer note: {claim.reviewNotes}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ClaimCategoryIcon category={claim.category} className="text-primary" />
                        <span>{categoryMeta[claim.category].label}</span>
                      </div>
                    </TableCell>
                    <TableCell>{formatShortDate(claim.submittedAt)}</TableCell>
                    <TableCell>{formatCurrency(claim.amount)}</TableCell>
                    <TableCell>
                      <ClaimStatusBadge status={claim.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
