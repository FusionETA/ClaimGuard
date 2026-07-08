"use server"

import { revalidatePath } from "next/cache"

import { safeErrorMessage } from "@/lib/errors"
import { applySalaryChangeHint } from "@/modules/payroll/application/services/salary-change-hints.service"
import { generatePayrollReport } from "@/modules/payroll/application/services/payroll-reports.service"
import {
  generatePayrollPayslips,
  getPayrollPayslipDetailPageData,
} from "@/modules/payroll/application/services/payroll-run.service"
import {
  importPayrollRunAdjustments,
  type AdjustmentImportError,
  type AdjustmentImportSummary,
} from "@/modules/payroll/application/services/payroll-run-adjustment-import.service"
import type { PayrollReportKind } from "@/modules/payroll/domain/reports"
import type { PayslipData } from "@/modules/payroll/domain/runs"

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
 * Server action called from the "Download files" modal. Generates the
 * requested report on the first click (caching to disk + DB), or
 * returns the cached entry on subsequent clicks. The client then
 * triggers a download against `fileUrl`.
 *
 * Always returns a result object — never throws — so the client can
 * surface a clean toast on failure.
 */
export type GeneratePayrollReportActionResult =
  | {
      status: "ready"
      fileName: string
      fileUrl: string
      mimeType: string
      sizeBytes: number
      alreadyCached: boolean
    }
  | {
      status: "error"
      message: string
    }

export async function generatePayrollReportAction(input: {
  runId: string
  kind: PayrollReportKind
  /// Optional admin-supplied payment date (PB ECP only). ISO YYYY-MM-DD.
  paymentDate?: string
}): Promise<GeneratePayrollReportActionResult> {
  try {
    const result = await generatePayrollReport({
      runId: input.runId,
      kind: input.kind,
      paymentDate: input.paymentDate,
    })
    // Hand the browser a route-handler URL, NOT the raw `/uploads/...`
    // path. Next.js doesn't serve files written to `public/` at
    // runtime, so the static path 404s; the route streams the bytes
    // off disk instead. The file itself was just written to disk by
    // `generatePayrollReport` above (with the correct PB ECP payment
    // date when applicable), so the route reads exactly that copy.
    const downloadUrl = `/admin/payroll/runs/${input.runId}/reports/${input.kind}`
    return {
      status: "ready",
      fileName: result.fileName,
      fileUrl: downloadUrl,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      alreadyCached: result.alreadyCached,
    }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not generate this file."),
    }
  }
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
