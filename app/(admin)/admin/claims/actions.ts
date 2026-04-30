"use server"

import { revalidatePath } from "next/cache"

import {
  createInitialReviewClaimFormState,
  type ReviewClaimFormState,
} from "@/app/(admin)/admin/claims/form-state"
import { getCurrentSession } from "@/lib/auth/session"
import { reviewClaimForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { invalidateAdminStore } from "@/modules/claims/application/services/admin-portal.service"
import { sendPushToUser } from "@/lib/web-push"

export type MarkPaidFormState = {
  status: "idle" | "success" | "error"
  message: string
}

export async function markClaimPaidAction(
  _prev: MarkPaidFormState,
  formData: FormData
): Promise<MarkPaidFormState> {
  const claimId = String(formData.get("claimId") ?? "")
  const bankAccountId = String(formData.get("bankAccountId") ?? "")

  if (!claimId || !bankAccountId) {
    return { status: "error", message: "Missing required fields." }
  }

  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const result = await claimRepository.markClaimAsPaid({
    claimId,
    payViaAccountId: bankAccountId,
    paidById: session.userId,
  })

  if (result !== "OK") {
    const messages = {
      NOT_FOUND: "Claim not found.",
      NOT_ACTIONABLE: "Only approved claims can be marked as paid.",
      DB_UNAVAILABLE: "Database is not configured. Contact your administrator.",
    } as const
    return { status: "error", message: messages[result] }
  }

  // Notify the employee
  try {
    const prisma = (await import("@/lib/prisma")).getPrismaClient()
    if (prisma) {
      const claim = await prisma.claim.findUnique({
        where: { id: claimId },
        select: { employeeId: true, title: true },
      })
      if (claim) {
        await sendPushToUser(claim.employeeId, {
          title: "Claim Paid",
          body: `Your claim "${claim.title}" has been paid.`,
          url: "/employee/claims",
        })
      }
    }
  } catch {
    // Push notifications never block the payout action.
  }

  invalidateAdminStore()
  revalidatePath("/admin")
  revalidatePath("/admin/claims")
  revalidatePath("/employee")
  revalidatePath("/employee/claims")

  return { status: "success", message: "Claim marked as paid." }
}

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
