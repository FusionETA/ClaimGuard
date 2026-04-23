import { ClaimCategoryIcon } from "@/components/claims/claim-category-icon"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import { categoryMeta } from "@/modules/claims/domain/metadata"
import type { ClaimRecord } from "@/modules/claims/domain/models"

export function AdminClaimsTable({ claims }: { claims: ClaimRecord[] }) {
  return (
    <Card>
      <CardHeader className="p-5 pb-3 sm:p-6 sm:pb-4">
        <CardTitle className="text-xl">Claims ledger</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Claim</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.map((claim) => (
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
  )
}
