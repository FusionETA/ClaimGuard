"use client"

import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"

import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PaginationControls } from "@/components/ui/pagination-controls"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn, formatCurrency, formatShortDate } from "@/lib/utils"
import { claimStatuses, type ClaimRecord, type ClaimStatus } from "@/modules/claims/domain/models"

const PAGE_SIZE = 10

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

export function AdminClaimsTable({ claims }: { claims: ClaimRecord[] }) {
  const [status, setStatus] = useState<ClaimStatus | "ALL">("ALL")
  const [searchTerm, setSearchTerm] = useState("")
  const [page, setPage] = useState(1)

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

      return matchesStatus && matchesQuery
    })
  }, [claims, searchTerm, status])

  useEffect(() => {
    setPage(1)
  }, [searchTerm, status])

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

      {filteredClaims.length > 0 ? (
        <div className="grid gap-3 sm:gap-4 md:hidden">
          {paginatedClaims.map((claim) => (
            <Card key={claim.id}>
              <CardContent className="space-y-3 p-4 sm:space-y-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                      {claim.claimNumber}
                    </p>
                    <p className="mt-1 text-base font-black sm:text-lg">{claim.title}</p>
                    <p className="text-xs text-muted-foreground sm:text-sm">
                      {claim.employee.name} · {claim.employee.jobTitle}
                    </p>
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
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {filteredClaims.length > 0 ? (
        <Card className="hidden md:block">
          <CardContent className="space-y-4 p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Claim</TableHead>
                  <TableHead>Chart of account</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedClaims.map((claim) => (
                  <TableRow key={claim.id}>
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
                        <p className="mt-1 font-bold">{claim.title}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {claim.chartOfAccount
                        ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                        : "Not assigned"}
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
  )
}
