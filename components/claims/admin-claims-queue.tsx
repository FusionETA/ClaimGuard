"use client"

import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"

import { AdminClaimReviewActions } from "@/components/claims/admin-claim-review-actions"
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
import {
  claimMatchesStatusFilter,
  visibleStatusOptions,
  type ClaimRecord,
  type ClaimStatus,
} from "@/modules/claims/domain/models"

const statusOptions = ["ALL", ...visibleStatusOptions] as const

type StatusFilter = (typeof statusOptions)[number]
const PAGE_SIZE = 10

function getSupervisorStep(claim: ClaimRecord, supervisorId?: string) {
  if (!supervisorId) return undefined
  return claim.approvalChain?.find((step) => step.approverId === supervisorId)
}

function getSupervisorDisplayStatus(
  claim: ClaimRecord,
  supervisorId?: string
): ClaimStatus {
  const step = getSupervisorStep(claim, supervisorId)
  if (step?.state === "approved") return "APPROVED"
  if (step?.state === "rejected") return "REJECTED"
  return claim.status
}

function isSupervisorActionable(claim: ClaimRecord, supervisorId?: string) {
  const step = getSupervisorStep(claim, supervisorId)
  if (step) {
    return (
      step.state === "current" &&
      (claim.status === "SUBMITTED" || claim.status === "PENDING")
    )
  }
  return claim.status === "SUBMITTED" || claim.status === "PENDING"
}

export function AdminClaimsQueue({
  claims,
  supervisorId,
}: {
  claims: ClaimRecord[]
  supervisorId?: string
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [searchTerm, setSearchTerm] = useState("")
  const [page, setPage] = useState(1)
  const [dismissedClaimIds, setDismissedClaimIds] = useState<Set<string>>(
    () => new Set()
  )

  useEffect(() => {
    setDismissedClaimIds(new Set())
  }, [claims])

  const filteredClaims = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return claims.filter((claim) => {
      if (dismissedClaimIds.has(claim.id)) return false

      const displayStatus = getSupervisorDisplayStatus(claim, supervisorId)
      const matchesStatus = claimMatchesStatusFilter(
        { status: displayStatus },
        statusFilter
      )

      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : [
              claim.claimNumber,
              claim.title,
              claim.employee.name,
              claim.employee.project,
              claim.chartOfAccount?.code,
              claim.chartOfAccount?.name,
            ]
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery)

      return matchesStatus && matchesQuery
    })
  }, [claims, dismissedClaimIds, searchTerm, statusFilter, supervisorId])

  useEffect(() => {
    setPage(1)
  }, [searchTerm, statusFilter])

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

  const hasActiveFilters = statusFilter !== "ALL" || searchTerm.trim().length > 0

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
              {statusOptions.map((status) => {
                const active = statusFilter === status
                const label =
                  status === "ALL"
                    ? "All"
                    : status === "PENDING"
                      ? "Pending"
                      : status[0] + status.slice(1).toLowerCase()

                return (
                  <Button
                    key={status}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "ghost"}
                    onClick={() => setStatusFilter(status)}
                    className={cn(
                      "rounded-full",
                      !active && "bg-surface-low text-muted-foreground hover:bg-surface-high hover:text-foreground"
                    )}
                  >
                    {label}
                  </Button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 md:hidden">
            {statusOptions.map((status) => {
              const active = statusFilter === status
              const label =
                status === "ALL"
                  ? "All"
                  : status === "PENDING"
                    ? "Pending"
                    : status[0] + status.slice(1).toLowerCase()

              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={cn(
                    "relative z-10 touch-manipulation rounded-[20px] px-4 py-3 text-sm font-semibold transition-all",
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              )
            })}
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
                  setStatusFilter("ALL")
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
          <CardContent className="p-8 text-center">
            <p className="text-lg font-bold text-foreground">No claims match this filter.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Try a different status or clear the search term.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {filteredClaims.length > 0 ? (
        <>
          <div className="grid gap-4 lg:hidden">
            {paginatedClaims.map((claim) => {
              const displayStatus = getSupervisorDisplayStatus(claim, supervisorId)
              const actionable = isSupervisorActionable(claim, supervisorId)

              return (
                <Card key={claim.id}>
                  <CardContent className="space-y-4 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          {claim.claimNumber}
                        </p>
                        <p className="mt-1 text-lg font-black">{claim.title}</p>
                        <p className="text-sm text-muted-foreground">{claim.employee.name}</p>
                      </div>
                      <ClaimStatusBadge status={displayStatus} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Account</p>
                        <p className="mt-1 font-semibold">
                          {claim.chartOfAccount
                            ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                            : "Not assigned"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Amount</p>
                        <p className="mt-1 font-semibold">{formatCurrency(claim.amount)}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface-low p-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Submitted</p>
                        <p className="mt-1 font-semibold">{formatShortDate(claim.submittedAt)}</p>
                      </div>
                      <AdminClaimReviewActions
                        claim={claim}
                        displayStatus={displayStatus}
                        actionable={actionable}
                        onReviewed={(claimId) => {
                          setDismissedClaimIds((current) => {
                            const next = new Set(current)
                            next.add(claimId)
                            return next
                          })
                        }}
                      />
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <Card className="hidden lg:block">
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
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedClaims.map((claim) => {
                    const displayStatus = getSupervisorDisplayStatus(claim, supervisorId)
                    const actionable = isSupervisorActionable(claim, supervisorId)

                    return (
                    <TableRow key={claim.id}>
                      <TableCell>
                        <div>
                          <p className="font-bold">{claim.employee.name}</p>
                          <p className="text-sm text-muted-foreground">{claim.employee.jobTitle}</p>
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
                        <ClaimStatusBadge status={displayStatus} />
                      </TableCell>
                      <TableCell>
                        <AdminClaimReviewActions
                          claim={claim}
                          displayStatus={displayStatus}
                          actionable={actionable}
                          onReviewed={(claimId) => {
                            setDismissedClaimIds((current) => {
                              const next = new Set(current)
                              next.add(claimId)
                              return next
                            })
                          }}
                        />
                      </TableCell>
                    </TableRow>
                    )
                  })}
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
        </>
      ) : null}

      {filteredClaims.length > 0 ? (
        <div className="lg:hidden">
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
