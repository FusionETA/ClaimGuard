"use server"

import { safeErrorMessage } from "@/lib/errors"
import { generatePayrollReport } from "@/modules/payroll/application/services/payroll-reports.service"
import { getPayrollPayslipDetailPageData } from "@/modules/payroll/application/services/payroll-run.service"
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
