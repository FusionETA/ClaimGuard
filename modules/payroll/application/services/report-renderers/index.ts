import "server-only"

import type { PayrollReportKind } from "@/modules/payroll/domain/reports"
import { renderBulkPayslipsPdf } from "@/modules/payroll/application/services/report-renderers/bulk-payslips-pdf"
import { renderEpfCsv } from "@/modules/payroll/application/services/report-renderers/epf-csv"
import { renderPaymentSchedulePdf } from "@/modules/payroll/application/services/report-renderers/payment-schedule-pdf"
import { renderPayrollSummaryPdf } from "@/modules/payroll/application/services/report-renderers/payroll-summary-pdf"
import { renderPbEcpXlsx } from "@/modules/payroll/application/services/report-renderers/pb-ecp-xlsx"
import { renderPcbLhdnFormPdf } from "@/modules/payroll/application/services/report-renderers/pcb-lhdn-form-pdf"
import { renderPcbTxt } from "@/modules/payroll/application/services/report-renderers/pcb-txt"
import { renderSocsoEisTxt } from "@/modules/payroll/application/services/report-renderers/socso-eis-txt"

/**
 * Dispatcher for the 7 payroll report renderers. Each renderer is a
 * thin async function that accepts a `runId` and returns the raw file
 * bytes ready to be written to disk.
 */
export async function renderPayrollReport(input: {
  runId: string
  kind: PayrollReportKind
  /// Admin-supplied payment date — only consumed by PB ECP today.
  paymentDate?: Date
}): Promise<Buffer> {
  switch (input.kind) {
    case "PAYROLL_SUMMARY_PDF":
      return renderPayrollSummaryPdf({ runId: input.runId })
    case "PAYMENT_SCHEDULE_PDF":
      return renderPaymentSchedulePdf({ runId: input.runId })
    case "PCB_LHDN_FORM_PDF":
      return renderPcbLhdnFormPdf({ runId: input.runId })
    case "BULK_PAYSLIPS_PDF":
      return renderBulkPayslipsPdf({ runId: input.runId })
    case "EPF_CSV":
      return renderEpfCsv({ runId: input.runId })
    case "SOCSO_EIS_TXT":
      return renderSocsoEisTxt({ runId: input.runId })
    case "PCB_TXT":
      return renderPcbTxt({ runId: input.runId })
    case "BANK_PB_ECP_XLSX":
      return renderPbEcpXlsx({
        runId: input.runId,
        paymentDate: input.paymentDate,
      })
  }
}
