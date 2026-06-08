import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { PcbCalculationDetailsPdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

/**
 * Renders the LHDN MTD §E worksheet PDF — one A4 page per employee
 * showing the full PCB calculation in the official LHDN form layout:
 * dark navy header bar, numbered sections, each LHDN variable in its
 * own table card with abbreviation + full description + amount, and
 * inline formula expansions for P / Yearly Tax / Current Month PCB.
 *
 * Audit-ready format. An LHDN officer familiar with the published
 * MTD worksheet should be able to read it without explanation.
 *
 * Sole PCB-breakdown PDF renderer — the older compact "Detailed
 * Calculations" renderer was removed in 2026-06.
 */
export async function renderPcbLhdnFormPdf(input: {
  runId: string
}): Promise<Buffer> {
  const data = await getPayrollRunDetailWithPayslipsPageData({
    runId: input.runId,
  })
  if (!data) throw new Error("Payroll run not found.")
  if (data.payslips.length === 0) {
    throw new Error(
      "Run payroll before downloading the PCB Calculation Details.",
    )
  }

  return renderToBuffer(
    <PcbCalculationDetailsPdfDocument
      organizationName={data.organizationName}
      period={periodLabel(data.run.periodYear, data.run.periodMonth)}
      payslips={data.payslips}
      generatedAt={new Date()}
    />,
  )
}
