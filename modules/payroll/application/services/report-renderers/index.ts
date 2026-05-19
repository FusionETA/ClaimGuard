import "server-only"

import type { PayrollReportKind } from "@/modules/payroll/domain/reports"
import { renderPayrollSummaryPdf } from "@/modules/payroll/application/services/report-renderers/payroll-summary-pdf"

/**
 * Dispatcher for the 7 payroll report renderers. Each renderer is a
 * thin async function that accepts a `runId` and returns the raw file
 * bytes ready to be written to disk.
 *
 * Until the remaining renderers land, the unimplemented kinds throw a
 * clear "coming soon" error so the modal can surface it.
 */
export async function renderPayrollReport(input: {
  runId: string
  kind: PayrollReportKind
}): Promise<Buffer> {
  switch (input.kind) {
    case "PAYROLL_SUMMARY_PDF":
      return renderPayrollSummaryPdf({ runId: input.runId })
    case "PAYMENT_SCHEDULE_PDF":
    case "DETAILED_CALCULATIONS_PDF":
    case "BULK_PAYSLIPS_PDF":
    case "EPF_CSV":
    case "SOCSO_EIS_TXT":
    case "PCB_TXT":
      throw new Error(
        `${input.kind} is not implemented yet. Phase A is still in progress.`,
      )
  }
}
