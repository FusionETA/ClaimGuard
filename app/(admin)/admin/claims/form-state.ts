import type { ClaimStatus } from "@/modules/claims/domain/models"

export type ReviewClaimFormValues = {
  reason: string
}

export type ReviewClaimFormState = {
  status: "idle" | "success" | "error"
  message: string
  values: ReviewClaimFormValues
  errors: Partial<Record<keyof ReviewClaimFormValues, string>>
  claimStatus?: ClaimStatus
  reviewerName?: string
}

export function createInitialReviewClaimFormState(
  reason = ""
): ReviewClaimFormState {
  return {
    status: "idle",
    message: "",
    values: {
      reason,
    },
    errors: {},
  }
}
