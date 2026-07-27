"use server"

import { revalidatePath } from "next/cache"

import { getCurrentSession } from "@/lib/auth/session"
import {
  addSupportingFilesToOwnClaim,
  deleteOwnEmployeeClaim,
  replaceOwnClaimReceipt,
  updateOwnEmployeeClaim,
} from "@/modules/claims/application/services/claim-workflow.service"
import type {
  AttachClaimFilesFormState,
  DeleteClaimFormState,
  ReplaceReceiptFormState,
  UpdateClaimFormState,
} from "@/app/(employee)/employee/claims/form-state"

/**
 * Server action: delete one of the employee's own claims. Allowed only
 * while the claim is still in SUBMITTED or PENDING status (the service
 * enforces this — the action just surfaces the result for the toast).
 */
export async function deleteClaimAction(
  _previousState: DeleteClaimFormState,
  formData: FormData,
): Promise<DeleteClaimFormState> {
  const claimId = String(formData.get("claimId") ?? "").trim()
  if (!claimId) {
    return { status: "error", message: "Missing claim id.", claimId }
  }

  const session = await getCurrentSession()
  if (!session) {
    return { status: "error", message: "Sign in to delete claims.", claimId }
  }

  const result = await deleteOwnEmployeeClaim({ session, claimId })
  if (!result.ok) {
    return { status: "error", message: result.message, claimId }
  }

  revalidatePath("/employee/claims")
  revalidatePath("/employee")
  // Supervisor's claim queue reads from the same claims table, so
  // their view must revalidate too — otherwise a subordinate's edit /
  // delete / attachment stays stale until the supervisor navigates.
  revalidatePath("/employee/review")
  revalidatePath("/admin/claims")
  return {
    status: "success",
    message: "Claim deleted.",
    claimId,
  }
}

/**
 * Server action: attach extra supporting documents to one of the
 * employee's own claims. Same eligibility window as deletion
 * (SUBMITTED / PENDING only — the service enforces this).
 */
export async function addSupportingFilesAction(
  _previousState: AttachClaimFilesFormState,
  formData: FormData,
): Promise<AttachClaimFilesFormState> {
  const claimId = String(formData.get("claimId") ?? "").trim()
  if (!claimId) {
    return { status: "error", message: "Missing claim id.", claimId }
  }

  const session = await getCurrentSession()
  if (!session) {
    return {
      status: "error",
      message: "Sign in to attach supporting documents.",
      claimId,
    }
  }

  const files = formData
    .getAll("supportingFile")
    .filter(
      (entry): entry is File =>
        entry instanceof File && entry.size > 0 && entry.name !== "",
    )

  if (files.length === 0) {
    return {
      status: "error",
      message: "Pick at least one file to attach.",
      claimId,
    }
  }

  const result = await addSupportingFilesToOwnClaim({
    session,
    claimId,
    files,
  })
  if (!result.ok) {
    return { status: "error", message: result.message, claimId }
  }

  revalidatePath("/employee/claims")
  revalidatePath("/employee")
  // Supervisor's claim queue reads from the same claims table, so
  // their view must revalidate too — otherwise a subordinate's edit /
  // delete / attachment stays stale until the supervisor navigates.
  revalidatePath("/employee/review")
  revalidatePath("/admin/claims")
  return {
    status: "success",
    message:
      result.warning ??
      `Attached ${result.inserted} file${result.inserted === 1 ? "" : "s"}.`,
    claimId,
    inserted: result.inserted,
  }
}

/**
 * Server action: edit an existing claim in-place. Validates scalar
 * fields (title / amount / spentAt / description / spendingAt /
 * spendingWith) via the service's Zod schema and surfaces per-field
 * errors back to the form. Account / payment-type / currency edits
 * require recreating the claim — they're not allowed here.
 */
export async function updateClaimAction(
  _previousState: UpdateClaimFormState,
  formData: FormData,
): Promise<UpdateClaimFormState> {
  const claimId = String(formData.get("claimId") ?? "").trim()
  if (!claimId) {
    return { status: "error", message: "Missing claim id.", claimId }
  }

  const session = await getCurrentSession()
  if (!session) {
    return { status: "error", message: "Sign in to edit claims.", claimId }
  }

  const rawAmount = String(formData.get("amount") ?? "").trim()
  const parsedAmount = Number(rawAmount)
  const input = {
    title: String(formData.get("title") ?? "").trim(),
    amount: Number.isFinite(parsedAmount) ? parsedAmount : Number.NaN,
    spentAt: String(formData.get("spentAt") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || undefined,
    spendingAt: String(formData.get("spendingAt") ?? "").trim() || undefined,
    spendingWith: String(formData.get("spendingWith") ?? "").trim() || undefined,
  }

  const result = await updateOwnEmployeeClaim({ session, claimId, input })
  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      claimId,
      fieldErrors: result.fieldErrors,
    }
  }

  revalidatePath("/employee/claims")
  revalidatePath("/employee")
  // Supervisor's claim queue reads from the same claims table, so
  // their view must revalidate too — otherwise a subordinate's edit /
  // delete / attachment stays stale until the supervisor navigates.
  revalidatePath("/employee/review")
  revalidatePath("/admin/claims")
  return { status: "success", message: "Claim updated.", claimId }
}

/**
 * Server action: swap the claim's primary receipt for a freshly
 * uploaded file. Same eligibility window as the other edits
 * (SUBMITTED / PENDING only — the service enforces this).
 */
export async function replaceReceiptAction(
  _previousState: ReplaceReceiptFormState,
  formData: FormData,
): Promise<ReplaceReceiptFormState> {
  const claimId = String(formData.get("claimId") ?? "").trim()
  if (!claimId) {
    return { status: "error", message: "Missing claim id.", claimId }
  }

  const session = await getCurrentSession()
  if (!session) {
    return { status: "error", message: "Sign in to replace the receipt.", claimId }
  }

  const candidate = formData.get("receiptFile")
  const receiptFile =
    candidate instanceof File && candidate.size > 0 ? candidate : null
  if (!receiptFile) {
    return {
      status: "error",
      message: "Pick a receipt file (JPG, PNG, WEBP, HEIC, or PDF).",
      claimId,
    }
  }

  const result = await replaceOwnClaimReceipt({
    session,
    claimId,
    receiptFile,
  })
  if (!result.ok) {
    return { status: "error", message: result.message, claimId }
  }

  revalidatePath("/employee/claims")
  revalidatePath("/employee")
  // Supervisor's claim queue reads from the same claims table, so
  // their view must revalidate too — otherwise a subordinate's edit /
  // delete / attachment stays stale until the supervisor navigates.
  revalidatePath("/employee/review")
  revalidatePath("/admin/claims")
  return {
    status: "success",
    message: result.warning ?? "Receipt replaced.",
    claimId,
    receiptUrl: result.receiptUrl,
  }
}
