"use server"

import { revalidatePath } from "next/cache"
import { safeErrorMessage } from "@/lib/errors"
import { redirect } from "next/navigation"
import { z } from "zod"

import type { BaseFormState } from "@/lib/form-state"
import {
  buildPayrollSyncPreview,
  type PayrollSyncPreviewResult,
} from "@/modules/payroll/application/services/xero-sync-preview.service"
import {
  approvePayrollRun,
  attachClaimToPayrollRun,
  attachLeaveCashoutToRun,
  createPayrollRunDraft,
  deletePayrollRunDraft,
  detachClaimFromPayrollRun,
  detachLeaveCashoutFromRun,
  generatePayrollPayslips,
  rejectPayrollRunApproval,
  revertPayrollRunToDraft,
  submitPayrollRunForApproval,
} from "@/modules/payroll/application/services/payroll-run.service"

/**
 * Server actions for the payroll-run shell.
 *
 *   - createPayrollRunDraftAction   → on success, redirects to the new
 *     run's detail page so the admin lands on the editing surface.
 *   - deletePayrollRunDraftAction   → on success, redirects back to the
 *     list (the draft no longer exists, so there's nothing to view).
 *
 * Both return a `BaseFormState` for the failure path; the redirect on
 * success means the success branch is never actually rendered.
 */

const createSchema = z.object({
  periodYear: z.coerce.number().int().min(2000).max(2099),
  periodMonth: z.coerce.number().int().min(1).max(12),
  /// Comma-separated list of EmployeePolicy ids selected in the
  /// "Create draft" dialog. Empty / missing = no scope (org-wide).
  /// The picker enforces "≥ 1 selected" client-side; the server
  /// validates the ids belong to the org + the admin's granted scope.
  policyIds: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
})

export async function createPayrollRunDraftAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = createSchema.safeParse({
    periodYear: formData.get("periodYear"),
    periodMonth: formData.get("periodMonth"),
    policyIds: formData.get("policyIds"),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message:
        parsed.error.issues[0]?.message ??
        "Pick a valid year (2000–2099) and month (1–12).",
    }
  }

  let runId: string
  try {
    const run = await createPayrollRunDraft({
      periodYear: parsed.data.periodYear,
      periodMonth: parsed.data.periodMonth,
      policyIds: parsed.data.policyIds,
    })
    runId = run.id
  } catch (err) {
    // Always log the underlying error to the server console so a
    // generic "Could not create payroll run." toast in the UI can be
    // traced back to the real cause (e.g. an unmapped Prisma error
    // code) without round-tripping through users.
    console.error("[createPayrollRunDraftAction] failed", {
      periodYear: parsed.data.periodYear,
      periodMonth: parsed.data.periodMonth,
      policyIds: parsed.data.policyIds,
      err,
    })
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not create payroll run."),
    }
  }

  revalidatePath("/admin/payroll/runs")
  revalidatePath("/admin/payroll")
  redirect(`/admin/payroll/runs/${runId}`)
}

const deleteSchema = z.object({
  runId: z.string().min(1),
})

export async function deletePayrollRunDraftAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = deleteSchema.safeParse({
    runId: formData.get("runId"),
  })

  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }

  try {
    await deletePayrollRunDraft({ runId: parsed.data.runId })
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not delete payroll run."),
    }
  }

  revalidatePath("/admin/payroll/runs")
  revalidatePath("/admin/payroll")
  redirect("/admin/payroll/runs")
}

const generateSchema = z.object({
  runId: z.string().min(1),
})

export async function generatePayrollPayslipsAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = generateSchema.safeParse({ runId: formData.get("runId") })
  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }

  let count: number
  try {
    const result = await generatePayrollPayslips({ runId: parsed.data.runId })
    count = result.count
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not run payroll."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  revalidatePath("/admin/payroll/runs")
  return {
    status: "success",
    message: `Payroll run completed for ${count} employee${count === 1 ? "" : "s"}.`,
  }
}

// ─── Claim attachment actions (Phase 5) ──────────────────────────────────

const attachClaimSchema = z.object({
  runId: z.string().min(1),
  claimId: z.string().min(1),
})

export async function attachClaimToPayrollRunAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = attachClaimSchema.safeParse({
    runId: formData.get("runId"),
    claimId: formData.get("claimId"),
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run or claim id." }
  }

  try {
    await attachClaimToPayrollRun(parsed.data)
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not attach claim."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  return { status: "success", message: "Claim added to payroll run." }
}

const detachClaimSchema = z.object({
  runId: z.string().min(1),
  claimId: z.string().min(1),
})

export async function detachClaimFromPayrollRunAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = detachClaimSchema.safeParse({
    runId: formData.get("runId"),
    claimId: formData.get("claimId"),
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run or claim id." }
  }

  try {
    await detachClaimFromPayrollRun({ claimId: parsed.data.claimId })
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not detach claim."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  return { status: "success", message: "Claim removed from payroll run." }
}

// ─── Expired leave cash-out ──────────────────────────────────────────────

const attachLeaveCashoutSchema = z.object({
  runId: z.string().min(1),
  entitlementId: z.string().min(1),
})

export async function attachLeaveCashoutToRunAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = attachLeaveCashoutSchema.safeParse({
    runId: formData.get("runId"),
    entitlementId: formData.get("entitlementId"),
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run or entitlement id." }
  }
  try {
    await attachLeaveCashoutToRun(parsed.data)
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not attach leave cash-out."),
    }
  }
  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  return { status: "success", message: "Leave cash-out attached to run." }
}

const detachLeaveCashoutSchema = z.object({
  runId: z.string().min(1),
  entitlementId: z.string().min(1),
})

export async function detachLeaveCashoutFromRunAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = detachLeaveCashoutSchema.safeParse({
    runId: formData.get("runId"),
    entitlementId: formData.get("entitlementId"),
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run or entitlement id." }
  }
  try {
    await detachLeaveCashoutFromRun({ entitlementId: parsed.data.entitlementId })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not detach leave cash-out."),
    }
  }
  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  return { status: "success", message: "Leave cash-out removed from run." }
}

// ─── Approval flow (Phase 21) ────────────────────────────────────────────

const submitForApprovalSchema = z.object({
  runId: z.string().min(1),
})

/**
 * Step 1: Admin submits a draft run "for approval".
 * Transitions DRAFT → PENDING_APPROVAL and locks edits. Another admin
 * (or the same admin) must then call the approve action to actually
 * finalise the run.
 */
export async function submitPayrollRunForApprovalAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = submitForApprovalSchema.safeParse({
    runId: formData.get("runId"),
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }

  try {
    await submitPayrollRunForApproval({ runId: parsed.data.runId })
  } catch (err) {
    return {
      status: "error",
      message:
        err instanceof Error
          ? err.message
          : "Could not submit run for approval.",
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  revalidatePath("/admin/payroll/runs")
  revalidatePath("/admin/payroll")
  return { status: "success", message: "Payroll run sent for approval." }
}

const approveSchema = z.object({
  runId: z.string().min(1),
})

/**
 * Step 2: Approver finalises a PENDING_APPROVAL run.
 * Transitions PENDING_APPROVAL → SUBMITTED, exposes payslips to the
 * affected employees, and records the approver as `submittedBy`.
 */
export async function approvePayrollRunAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = approveSchema.safeParse({ runId: formData.get("runId") })
  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }

  let xeroSyncOutcome: Awaited<
    ReturnType<typeof approvePayrollRun>
  >["xeroSync"]
  try {
    const result = await approvePayrollRun({ runId: parsed.data.runId })
    xeroSyncOutcome = result.xeroSync
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not approve payroll run."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  revalidatePath("/admin/payroll/runs")
  revalidatePath("/admin/payroll")
  revalidatePath("/employee/payslips")

  // Build a message that includes the Xero sync outcome so the admin
  // gets one toast covering both events.
  let message = "Payroll run approved and submitted."
  if (xeroSyncOutcome?.status === "synced") {
    message += ` Posted to Xero — journal ${xeroSyncOutcome.narration}.`
  } else if (xeroSyncOutcome?.status === "skipped") {
    message += ` Xero sync skipped — ${xeroSyncOutcome.message}`
  } else if (xeroSyncOutcome?.status === "error") {
    // Approval succeeded but Xero failed — still success-shaped so
    // the admin sees the approval landed; they can retry sync from
    // the run page.
    return {
      status: "success",
      message: `${message} Xero sync failed: ${xeroSyncOutcome.message}`,
    }
  }
  return { status: "success", message }
}

const rejectApprovalSchema = z.object({
  runId: z.string().min(1),
  reason: z.string().max(500).optional(),
})

/**
 * Approver bounces a PENDING_APPROVAL run back to DRAFT.
 * An optional reason is captured and persisted on the run so the
 * original submitter knows what to fix before re-submitting.
 */
export async function rejectPayrollRunApprovalAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = rejectApprovalSchema.safeParse({
    runId: formData.get("runId"),
    reason: formData.get("reason") ?? undefined,
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }

  try {
    await rejectPayrollRunApproval({
      runId: parsed.data.runId,
      reason: parsed.data.reason?.trim() || null,
    })
  } catch (err) {
    return {
      status: "error",
      message:
        err instanceof Error
          ? err.message
          : "Could not send the payroll run back to draft.",
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  revalidatePath("/admin/payroll/runs")
  revalidatePath("/admin/payroll")
  return { status: "success", message: "Payroll run sent back to draft." }
}

const revertSchema = z.object({
  runId: z.string().min(1),
})

export async function revertPayrollRunAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = revertSchema.safeParse({ runId: formData.get("runId") })
  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }

  try {
    await revertPayrollRunToDraft({ runId: parsed.data.runId })
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not revert payroll run."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  revalidatePath("/admin/payroll/runs")
  revalidatePath("/admin/payroll")
  revalidatePath("/employee/payslips")
  return { status: "success", message: "Payroll run reverted to draft." }
}

// ─── Xero sync: preview + retry ──────────────────────────────────────────

/**
 * Build a preview of what will be posted to Xero when this run is
 * approved. Used by the pre-approval modal so the admin sees the
 * journal lines before clicking Confirm.
 */
export async function getPayrollSyncPreviewAction(input: {
  runId: string
}): Promise<PayrollSyncPreviewResult> {
  if (!input.runId) {
    return { status: "error", message: "Missing run id." }
  }
  try {
    return await buildPayrollSyncPreview(input.runId)
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not load sync preview."),
    }
  }
}

const retrySyncSchema = z.object({
  runId: z.string().min(1),
})

/**
 * Re-attempt the manual-journal post for a SUBMITTED run whose
 * earlier sync failed. The same `syncPayrollRunToXero` service runs
 * — it'll either succeed (status flips to SYNCED, error cleared) or
 * fail again (error message refreshed, run stays SUBMITTED).
 *
 * Idempotent: refuses if `xeroManualJournalId` is already set, so
 * an admin can't accidentally double-post.
 */
export async function retryPayrollRunXeroSyncAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = retrySyncSchema.safeParse({ runId: formData.get("runId") })
  if (!parsed.success) {
    return { status: "error", message: "Missing run id." }
  }
  try {
    const { syncPayrollRunToXero } = await import(
      "@/modules/payroll/application/services/xero-payroll-sync.service"
    )
    const result = await syncPayrollRunToXero(parsed.data.runId)
    revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
    if (result.status === "synced") {
      return {
        status: "success",
        message: `Posted to Xero — journal ${result.narration}.`,
      }
    }
    if (result.status === "skipped") {
      return { status: "success", message: `Sync skipped: ${result.message}` }
    }
    return { status: "error", message: result.message }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Retry failed."),
    }
  }
}
