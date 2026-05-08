"use server"

import { revalidatePath } from "next/cache"

import {
  type ReviewClaimFormState,
} from "@/app/(admin)/admin/claims/form-state"
import { getCurrentSession } from "@/lib/auth/session"
import {
  reviewClaimForAdmin,
  reviewClaimForSupervisor,
  syncClaimToXero,
} from "@/modules/claims/application/services/claim-workflow.service"

/**
 * Admin's final review action. Used from the /admin/claims table after
 * all supervisors in the chain have signed off (or when there's no chain
 * at all). The admin approves or rejects only — chart-of-account changes
 * happen at the sync stage (`syncClaimAction`), not here.
 */
export async function adminFinalReviewClaimAction(
  _previousState: ReviewClaimFormState,
  formData: FormData
): Promise<ReviewClaimFormState> {
  const values = {
    claimId: String(formData.get("claimId") ?? ""),
    decision: String(formData.get("decision") ?? "APPROVED"),
    reason: String(formData.get("reason") ?? ""),
  }

  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
      values: {
        reason: values.reason,
      },
      errors: {},
    }
  }

  const result = await reviewClaimForAdmin({
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
      result.claimStatus === "REVIEWED"
        ? "Admin review recorded."
        : "Claim rejected and reason saved.",
    values: {
      reason: result.reason,
    },
    errors: {},
    claimStatus: result.claimStatus,
    reviewerName: result.reviewerName,
  }
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
        : result.claimStatus === "PENDING"
          ? "Approval recorded and sent to the next supervisor."
        : "Claim rejected and reason saved.",
    values: {
      reason: result.reason,
    },
    errors: {},
    claimStatus: result.claimStatus,
    reviewerName: result.reviewerName,
  }
}

/**
 * Push a REVIEWED claim to Xero. The admin can pass an optional final
 * `chartOfAccountId` to recode the claim immediately before sync — this
 * is the ONLY post-approval point where COA can change. Currently the
 * service stub flips xeroSyncStatus to SYNCED without hitting Xero so
 * the workflow can be tested end-to-end before the real Xero call is
 * wired in.
 *
 * Returns a plain object so the caller can render an inline toast; the
 * sync UI uses a small useTransition pattern rather than useActionState.
 */
export async function syncClaimAction(input: {
  claimId: string
  chartOfAccountId?: string
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const result = await syncClaimToXero({ session, input })

  if (!result.ok) {
    return { ok: false, message: result.message }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/claims")
  revalidatePath("/employee")
  revalidatePath("/employee/claims")

  return { ok: true, message: `Synced "${result.claimTitle}".` }
}

/**
 * Bulk-sync N claims at once. Each row is pushed with its CURRENT chart
 * of account — bulk mode does not let admins recode per-claim. If the
 * admin needs to change a COA, they sync that one row individually
 * through the per-row dialog first.
 *
 * Strategy: process sequentially (each claim is its own DB transaction
 * inside `syncClaimToXero`), collect per-claim results, then revalidate
 * paths ONCE at the end. Sequential is fine here — sync workloads are
 * tiny (the heavy work is the future Xero API call, which we'll need to
 * rate-limit anyway).
 *
 * Partial-success semantics: returns `ok: true` if at least one claim
 * synced; the caller surfaces both counts so the admin can re-try the
 * failures from the table (rows that synced disappear, rows that failed
 * stay).
 */
export async function syncClaimsBulkAction(input: {
  claimIds: string[]
}): Promise<{
  ok: boolean
  message: string
  syncedCount: number
  failedCount: number
  failures: Array<{ claimId: string; message: string }>
}> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return {
      ok: false,
      message: "Session expired. Please log in again.",
      syncedCount: 0,
      failedCount: 0,
      failures: [],
    }
  }

  // De-dup defensively in case the UI hands us the same id twice.
  const uniqueIds = Array.from(new Set(input.claimIds.filter(Boolean)))

  if (uniqueIds.length === 0) {
    return {
      ok: false,
      message: "No claims selected.",
      syncedCount: 0,
      failedCount: 0,
      failures: [],
    }
  }

  let syncedCount = 0
  const failures: Array<{ claimId: string; message: string }> = []

  for (const claimId of uniqueIds) {
    const result = await syncClaimToXero({
      session,
      input: { claimId },
    })
    if (result.ok) {
      syncedCount += 1
    } else {
      failures.push({ claimId, message: result.message })
    }
  }

  if (syncedCount > 0) {
    revalidatePath("/admin")
    revalidatePath("/admin/claims")
    revalidatePath("/employee")
    revalidatePath("/employee/claims")
  }

  const failedCount = failures.length
  const total = uniqueIds.length

  let message: string
  if (failedCount === 0) {
    message =
      total === 1
        ? "Synced 1 claim."
        : `Synced ${total} claims.`
  } else if (syncedCount === 0) {
    message = `Couldn't sync any claims — ${failedCount} failed.`
  } else {
    message = `Synced ${syncedCount} of ${total} — ${failedCount} failed.`
  }

  return {
    ok: syncedCount > 0,
    message,
    syncedCount,
    failedCount,
    failures,
  }
}
