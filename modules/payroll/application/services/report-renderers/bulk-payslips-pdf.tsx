import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { BulkPayslipsPdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

export async function renderBulkPayslipsPdf(input: {
  runId: string
}): Promise<Buffer> {
  const data = await getPayrollRunDetailWithPayslipsPageData({
    runId: input.runId,
  })
  if (!data) throw new Error("Payroll run not found.")
  if (data.payslips.length === 0) {
    throw new Error("Run payroll before downloading the bulk payslips.")
  }

  // Issue date = last day of the period month, which is the
  // convention on the existing single-payslip view.
  const issueDate = new Date(
    data.run.periodYear,
    data.run.periodMonth, // monthIndex = month-1, so passing month gives last day of prev month — we use day 0 of next month
    0,
  )

  return renderToBuffer(
    <BulkPayslipsPdfDocument
      organizationName={data.organizationName}
      period={periodLabel(data.run.periodYear, data.run.periodMonth)}
      issueDate={issueDate}
      payslips={data.payslips}
      generatedAt={new Date()}
    />,
  )
}
