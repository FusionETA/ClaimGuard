"use server"

import { reviewClaimAction as reviewClaim } from "@/app/(admin)/admin/claims/actions"
import type { ReviewClaimFormState } from "@/app/(admin)/admin/claims/form-state"

export async function reviewClaimAction(
  previousState: ReviewClaimFormState,
  formData: FormData
): Promise<ReviewClaimFormState> {
  return reviewClaim(previousState, formData)
}
