"use server"

import { revalidatePath } from "next/cache"

import { safeErrorMessage } from "@/lib/errors"
import { applySalaryChangeHint } from "@/modules/payroll/application/services/salary-change-hints.service"
import {
  generatePayrollPayslips,
  getPayrollPayslipDetailPageData,
} from "@/modules/payroll/application/services/payroll-run.service"
import {
  importPayrollRunAdjustments,
  type AdjustmentImportError,
  type AdjustmentImportSummary,
} from "@/modules/payroll/application/services/payroll-run-adjustment-import.service"
import type { PayslipData } from "@/modules/payroll/domain/runs"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import {
  emailPayslip,
  emailPayslipsForRun,
} from "@/modules/payroll/application/services/payslip-email.service"

/**
 * Lazy-load the full payslip data — including line items, EPF rates
 * snapshot, and statutory warnings — for the inline expandable row
 * on the run detail page. The list view (`PayslipRow`) deliberately
 * excludes line items for performance; this action fills in the gap
 * only when the admin clicks to expand a row.
 *
 * Returns null when the session/org doesn't match or the payslip
 * isn't on a run this admin can see.
 */
export async function fetchPayslipDetailForExpansionAction(input: {
  payslipId: string
}): Promise<PayslipData | null> {
  const result = await getPayrollPayslipDetailPageData({
    payslipId: input.payslipId,
  })
  if (!result) return null
  return result.payslip
}

/**
 * Apply a mid-cycle salary-change hint. Called from the smart-hint
 * banner on the run-detail page. On success returns `{ status:
 * "success", message }`; on failure returns `{ status: "error" }`.
 * Caller wires the result through `useActionState` / a toast so the
 * admin sees what happened.
 *
 * Revalidates the run-detail page so the banner self-hides (now that
 * the marker is in the manualLineItems) and the payslip totals
 * refresh on next render.
 */
export type ApplySalaryChangeHintActionResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string }

export async function applySalaryChangeHintAction(input: {
  runId: string
  payslipId: string
  salaryChangeId: string
}): Promise<ApplySalaryChangeHintActionResult> {
  try {
    const result = await applySalaryChangeHint(input)
    // Adding the deduction only writes it to the run's manual-line-item
    // list — the payslip rows are frozen and don't reflect it until the
    // run is regenerated. Recompute here so the net pay updates
    // immediately (the whole point of "Apply adjustment"). Only when a
    // line was actually added (not a no-op "already applied").
    if (result.applied) {
      await generatePayrollPayslips({ runId: input.runId })
    }
    revalidatePath(`/admin/payroll/runs/${input.runId}`)
    return { status: "success", message: result.message }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not apply this adjustment."),
    }
  }
}

/**
 * Bulk-import per-run manual adjustments from an XLSX file. REPLACE
 * semantics — every existing manualLineItems on the run gets wiped
 * and rebuilt from the file. DRAFT runs only.
 *
 * The client posts the file as multipart/form-data with two fields:
 *   - runId: string
 *   - file:  Blob (the .xlsx)
 */
export async function importPayrollRunAdjustmentsAction(
  formData: FormData,
): Promise<AdjustmentImportSummary | AdjustmentImportError> {
  const runId = String(formData.get("runId") ?? "")
  if (runId.length === 0) {
    return { status: "error", message: "Missing run id." }
  }
  const file = formData.get("file")
  if (!(file instanceof Blob) || file.size === 0) {
    return {
      status: "error",
      message: "Attach an .xlsx file before submitting.",
    }
  }
  // Cheap upper bound so a huge upload can't OOM the server. Adjustment
  // files should be a few thousand rows at most.
  if (file.size > 10 * 1024 * 1024) {
    return {
      status: "error",
      message: "File is too large (max 10 MB).",
    }
  }
  try {
    const arrayBuffer = await file.arrayBuffer()
    const result = await importPayrollRunAdjustments({
      runId,
      fileBuffer: arrayBuffer,
    })
    if (result.status !== "success") return result

    // Auto re-run payroll so the payslip totals + PCB / EPF pick up
    // the imported adjustments immediately. Failures are non-fatal —
    // the import already succeeded and the admin can click Re-run
    // payroll manually if the auto attempt errors.
    let rerunWarning: string | undefined
    try {
      await generatePayrollPayslips({ runId })
    } catch (err) {
      rerunWarning = `Auto re-run failed (${safeErrorMessage(err, "unknown error")}). Click Re-run payroll to refresh totals.`
    }

    revalidatePath(`/admin/payroll/runs/${runId}`)
    return rerunWarning ? { ...result, rerunWarning } : result
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not import the file."),
    }
  }
}

/**
 * Email one employee their payslip as a password-protected PDF. Admin
 * only; the payslip must belong to a SUBMITTED run in the active org
 * (enforced in the service). Returns a plain `{ ok, message }` for an
 * inline toast.
 */
export async function emailPayslipAction(input: {
  payslipId: string
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organisation." }

  const result = await emailPayslip({ organizationId: orgId, payslipId: input.payslipId })
  if (!result.ok) {
    return { ok: false, message: result.reason ?? "Could not send the payslip." }
  }
  return { ok: true, message: `Payslip emailed to ${result.email}.` }
}

/**
 * Email every payslip on a SUBMITTED run to its employee. Returns a
 * summary message plus a list of human-readable failure lines the dialog
 * can show (name + reason) so the admin knows exactly who to follow up.
 */
export async function emailRunPayslipsAction(input: {
  runId: string
}): Promise<{ ok: boolean; message: string; failures: string[] }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again.", failures: [] }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organisation.", failures: [] }

  const summary = await emailPayslipsForRun({ organizationId: orgId, runId: input.runId })
  const failures = summary.results
    .filter((r) => !r.ok)
    .map((r) => `${r.name}${r.reason ? ` — ${r.reason}` : ""}`)
  const failedNote = summary.failed > 0 ? `, ${summary.failed} failed` : ""
  return {
    ok: summary.sent > 0 || summary.failed === 0,
    message: `Emailed ${summary.sent} payslip${summary.sent === 1 ? "" : "s"}${failedNote}.`,
    failures,
  }
}
