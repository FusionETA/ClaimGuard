import "server-only"

import type { PayrollReportKind } from "@/modules/payroll/domain/reports"
import { renderBulkPayslipsPdf } from "@/modules/payroll/application/services/report-renderers/bulk-payslips-pdf"
import { renderEpfCsv } from "@/modules/payroll/application/services/report-renderers/epf-csv"
import { renderPaymentSchedulePdf } from "@/modules/payroll/application/services/report-renderers/payment-schedule-pdf"
import { renderPayrollSummaryPdf } from "@/modules/payroll/application/services/report-renderers/payroll-summary-pdf"
import { renderCimbBizChannelTxt } from "@/modules/payroll/application/services/report-renderers/cimb-bizchannel-txt"
import {
  renderHlbConnectBizXlsx,
  renderHlbConnectFirstTxt,
} from "@/modules/payroll/application/services/report-renderers/hlb-connect"
import { renderMbbM2eTxt } from "@/modules/payroll/application/services/report-renderers/mbb-m2e-txt"
import { renderPbEcpXlsx } from "@/modules/payroll/application/services/report-renderers/pb-ecp-xlsx"
import { renderPcbLhdnFormPdf } from "@/modules/payroll/application/services/report-renderers/pcb-lhdn-form-pdf"
import { renderPcbTxt } from "@/modules/payroll/application/services/report-renderers/pcb-txt"
import { renderSocsoEisSkbbkTxt } from "@/modules/payroll/application/services/report-renderers/socso-eis-skbbk-txt"
import { renderSocsoEisTxt } from "@/modules/payroll/application/services/report-renderers/socso-eis-txt"

/**
 * Dispatcher for the 8 payroll report renderers. Each renderer is a
 * thin async function that accepts a `runId` and returns the raw file
 * bytes ready to be written to disk.
 */
export async function renderPayrollReport(input: {
  runId: string
  kind: PayrollReportKind
  /// Already-authorised org that owns the run. Threaded into every renderer
  /// so they can load data without an admin session — this is what lets the
  /// token-authed `/api/v1` payroll download reuse the same generators.
  organizationId: string
  /// Policy scope for the payslip-backed PDFs. null (or omitted) = whole
  /// run (token endpoint); the in-app caller passes the admin's scope so a
  /// restricted admin keeps seeing only their employees. Ignored by the
  /// statutory + bank files, which are always whole-run.
  policyIdScope?: string[] | null
  /// Admin-supplied payment/value date — consumed by every bank file.
  paymentDate?: Date
  /// Beneficiary reference typed per payment run. Mandatory on the Hong
  /// Leong formats; ignored by the others.
  recipientReference?: string
}): Promise<Buffer> {
  const { runId, organizationId } = input
  const policyIdScope = input.policyIdScope ?? null
  switch (input.kind) {
    case "PAYROLL_SUMMARY_PDF":
      return renderPayrollSummaryPdf({ runId, organizationId, policyIdScope })
    case "PAYMENT_SCHEDULE_PDF":
      return renderPaymentSchedulePdf({ runId, organizationId, policyIdScope })
    case "PCB_LHDN_FORM_PDF":
      return renderPcbLhdnFormPdf({ runId, organizationId, policyIdScope })
    case "BULK_PAYSLIPS_PDF":
      return renderBulkPayslipsPdf({ runId, organizationId, policyIdScope })
    case "EPF_CSV":
      return renderEpfCsv({ runId, organizationId })
    case "SOCSO_EIS_TXT":
      return renderSocsoEisTxt({ runId, organizationId })
    case "SOCSO_EIS_SKBBK_TXT":
      return renderSocsoEisSkbbkTxt({ runId, organizationId })
    case "PCB_TXT":
      return renderPcbTxt({ runId, organizationId })
    case "BANK_PB_ECP_XLSX":
      return renderPbEcpXlsx({
        runId,
        organizationId,
        paymentDate: input.paymentDate,
      })
    case "BANK_MBB_M2E_TXT":
      return renderMbbM2eTxt({
        runId,
        organizationId,
        paymentDate: input.paymentDate,
      })
    case "BANK_HLB_CONNECT_FIRST_TXT":
      return renderHlbConnectFirstTxt({
        runId,
        organizationId,
        recipientReference: input.recipientReference,
      })
    case "BANK_HLB_CONNECT_BIZ_XLSX":
      return renderHlbConnectBizXlsx({
        runId,
        organizationId,
        recipientReference: input.recipientReference,
      })
    case "BANK_CIMB_BIZCHANNEL_TXT":
      return renderCimbBizChannelTxt({
        runId,
        organizationId,
        paymentDate: input.paymentDate,
      })
  }
}
