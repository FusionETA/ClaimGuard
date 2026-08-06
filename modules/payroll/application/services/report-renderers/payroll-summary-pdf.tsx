import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { PayrollSummaryPdfDocument } from "@/components/admin/payroll-summary-pdf-document"
import { getPayrollRunDetailWithPayslipsPageDataForOrg } from "@/modules/payroll/application/services/payroll-run.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

/**
 * Renders the "Payroll Summary" PDF to a Buffer for disk caching.
 *
 * Reuses the existing `PayrollSummaryPdfDocument` React-PDF component
 * (also used by the legacy on-demand /summary route) — same layout,
 * same numbers, just buffered instead of streamed so we can hash +
 * write it to disk.
 */
export async function renderPayrollSummaryPdf(input: {
  runId: string
  /// Already-authorised org that owns the run (threaded from
  /// `renderPayrollReport`). Replaces the old admin-session read.
  organizationId: string
  /// Policy scope for the payslip data — null (or omitted) renders the whole
  /// run (token endpoint); the in-app caller passes the admin's scope.
  policyIdScope?: string[] | null
}): Promise<Buffer> {
  const data = await getPayrollRunDetailWithPayslipsPageDataForOrg({
    runId: input.runId,
    organizationId: input.organizationId,
    policyIdScope: input.policyIdScope ?? null,
  })
  if (!data) throw new Error("Payroll run not found.")
  if (data.payslips.length === 0) {
    throw new Error(
      "Run payroll before downloading the summary — there are no payslips on this run.",
    )
  }

  const period = periodLabel(data.run.periodYear, data.run.periodMonth)

  return renderToBuffer(
    <PayrollSummaryPdfDocument
      organizationName={data.organizationName}
      period={period}
      payslips={data.payslips}
      generatedAt={new Date()}
    />,
  )
}
