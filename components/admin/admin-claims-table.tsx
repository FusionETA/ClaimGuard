"use client"

import { useEffect, useMemo, useState } from "react"

import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PaginationControls } from "@/components/ui/pagination-controls"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import type { ClaimRecord } from "@/modules/claims/domain/models"

const PAGE_SIZE = 10

export function AdminClaimsTable({ claims }: { claims: ClaimRecord[] }) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(claims.length / PAGE_SIZE))

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const paginatedClaims = useMemo(() => {
    const startIndex = (page - 1) * PAGE_SIZE
    return claims.slice(startIndex, startIndex + PAGE_SIZE)
  }, [claims, page])

  return (
    <Card>
      <CardHeader className="p-5 pb-3 sm:p-6 sm:pb-4">
        <CardTitle className="text-xl">Claims ledger</CardTitle>
      </CardHeader>
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
          totalItems={claims.length}
          itemLabel="claims"
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  )
}
