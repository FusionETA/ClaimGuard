import { type ClaimStatus } from "@/modules/claims/domain/models"

import { Badge } from "@/components/ui/badge"

const labelMap: Record<ClaimStatus, string> = {
  SUBMITTED: "Pending",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PAID: "Paid",
  SETTLED: "Settled",
}

const variantMap: Record<
  ClaimStatus,
  "pending" | "approved" | "rejected" | "paid"
> = {
  SUBMITTED: "pending",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  PAID: "paid",
  // Settled = company-money fully approved (no payout step). Reuse the "paid" variant.
  SETTLED: "paid",
}

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return <Badge variant={variantMap[status]}>{labelMap[status]}</Badge>
}
