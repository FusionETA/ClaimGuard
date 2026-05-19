import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { DetailedCalculationsPdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

export async function renderDetailedCalculationsPdf(input: {
  runId: string
}): Promise<Buffer> {
  const data = await getPayrollRunDetailWithPayslipsPageData({
    runId: input.runId,
  })
  if (!data) throw new Error("Payroll run not found.")
  if (data.payslips.length === 0) {
    throw new Error(
      "Run payroll before downloading the detailed calculations.",
    )
  }

  return renderToBuffer(
    <DetailedCalculationsPdfDocument
      organizationName={data.organizationName}
      period={periodLabel(data.run.periodYear, data.run.periodMonth)}
      payslips={data.payslips}
      generatedAt={new Date()}
    />,
  )
}
