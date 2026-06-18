import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { BulkPayslipsPdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"
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

  // Hydrate each payslip with the two extras the dense PDF needs:
  // (1) identity fields (IC, join date, statutory ref numbers, bank
  //     info) — read live from PayrollProfile so admins can amend a
  //     typo without reverting the run; (2) calendar-year-to-date
  //     totals through this period for the per-statutory matrix.
  const enriched = await Promise.all(
    data.payslips.map(async (p) => {
      const [identity, ytd] = await Promise.all([
        payslipRepository.getPayslipHeaderIdentity({
          employeeProfileId: p.employeeProfileId,
        }),
        payslipRepository.getYtdSummaryThroughPeriod({
          employeeProfileId: p.employeeProfileId,
          year: data.run.periodYear,
          month: data.run.periodMonth,
        }),
      ])
      return {
        ...p,
        identity,
        ytd,
      }
    }),
  )

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
      payslips={enriched}
      generatedAt={new Date()}
    />,
  )
}
