"use server"

import { revalidatePath } from "next/cache"

import {
  createInitialReviewClaimFormState,
  type ReviewClaimFormState,
} from "@/app/(admin)/admin/claims/form-state"
import { getCurrentSession } from "@/lib/auth/session"
import { reviewClaimForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"

export async function reviewClaimAction(
  _previousState: ReviewClaimFormState,
  formData: FormData
): Promise<ReviewClaimFormState> {
  const values = {
    claimId: String(formData.get("claimId") ?? ""),
    decision: String(formData.get("decision") ?? "APPROVED"),
    reason: String(formData.get("reason") ?? ""),
  }

  const session = await getCurrentSession()

  if (!session || session.role !== "SUPERVISOR") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
      values: {
        reason: values.reason,
      },
      errors: {},
    }
  }

  const result = await reviewClaimForSupervisor({
    session,
    input: values,
  })

  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      values: {
        reason: result.reason ?? values.reason,
      },
      errors: result.fieldErrors ?? {},
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/claims")
  revalidatePath("/employee")
  revalidatePath("/employee/claims")
  revalidatePath("/employee/review")

  return {
    status: "success",
    message:
      result.claimStatus === "APPROVED"
        ? "Claim approved successfully."
        : "Claim rejected and reason saved.",
    values: {
      reason: result.reason,
    },
    errors: {},
    claimStatus: result.claimStatus,
    reviewerName: result.reviewerName,
  }
}
