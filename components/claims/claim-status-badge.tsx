import { type ClaimStatus, type ReviewerRole } from "@/modules/claims/domain/models"

import { Badge } from "@/components/ui/badge"

const labelMap: Record<ClaimStatus, string> = {
  SUBMITTED: "Pending",
  PENDING: "Pending",
  APPROVED: "Approved",
  REVIEWED: "Reviewed",
  REJECTED: "Rejected",
}

const variantMap: Record<ClaimStatus, "pending" | "approved" | "rejected"> = {
  SUBMITTED: "pending",
  PENDING: "pending",
  APPROVED: "approved",
  REVIEWED: "approved",
  REJECTED: "rejected",
}

// Statuses where "by Supervisor / by Admin" caption is meaningful. PENDING /
// SUBMITTED are still in flight so a reviewer caption would be misleading.
const SHOW_REVIEWER_FOR: ReadonlyArray<ClaimStatus> = [
  "APPROVED",
  "REVIEWED",
  "REJECTED",
]

export function ClaimStatusBadge({
  status,
  reviewerRole,
}: {
  status: ClaimStatus
  reviewerRole?: ReviewerRole
}) {
  const showReviewer = reviewerRole && SHOW_REVIEWER_FOR.includes(status)

  if (!showReviewer) {
    return <Badge variant={variantMap[status]}>{labelMap[status]}</Badge>
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5 leading-none">
      <Badge variant={variantMap[status]}>{labelMap[status]}</Badge>
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        by {reviewerRole === "ADMIN" ? "Admin" : "Supervisor"}
      </span>
    </span>
  )
}
