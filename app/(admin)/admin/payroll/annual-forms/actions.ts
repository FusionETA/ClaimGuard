"use server"

import { safeErrorMessage } from "@/lib/errors"
import { generatePayrollAnnualReport } from "@/modules/payroll/application/services/payroll-annual-reports.service"
import type { PayrollAnnualReportKind } from "@/modules/payroll/domain/annual-reports"

/**
 * Server action called from the Annual Tax Forms modal. Same shape as
 * the per-run `generatePayrollReportAction` — renders on first click,
 * returns the cached entry on subsequent clicks. Errors are returned
 * as a structured object so the modal can render a toast.
 */
export type GeneratePayrollAnnualReportActionResult =
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

export async function generatePayrollAnnualReportAction(input: {
  year: number
  kind: PayrollAnnualReportKind
}): Promise<GeneratePayrollAnnualReportActionResult> {
  try {
    const result = await generatePayrollAnnualReport({
      year: input.year,
      kind: input.kind,
    })
    return {
      status: "ready",
      fileName: result.fileName,
      fileUrl: result.fileUrl,
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
