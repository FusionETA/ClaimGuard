"use server"

import { revalidatePath } from "next/cache"
import { safeErrorMessage } from "@/lib/errors"
import { redirect } from "next/navigation"
import { z } from "zod"

import type { BaseFormState } from "@/lib/form-state"
import {
  approvePayrollRun,
  attachClaimToPayrollRun,
  createPayrollRunDraft,
  deletePayrollRunDraft,
  detachClaimFromPayrollRun,
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
})

export async function createPayrollRunDraftAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = createSchema.safeParse({
    periodYear: formData.get("periodYear"),
    periodMonth: formData.get("periodMonth"),
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
    const run = await createPayrollRunDraft(parsed.data)
    runId = run.id
  } catch (err) {
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

  try {
    await approvePayrollRun({ runId: parsed.data.runId })
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
  return { status: "success", message: "Payroll run approved and submitted." }
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
