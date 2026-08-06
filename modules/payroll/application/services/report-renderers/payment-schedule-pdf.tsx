import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { PaymentSchedulePdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageDataForOrg } from "@/modules/payroll/application/services/payroll-run.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

export async function renderPaymentSchedulePdf(input: {
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
    throw new Error("Run payroll before downloading the payment schedule.")
  }

  const totals = data.payslips.reduce(
    (acc, p) => {
      acc.pcb += p.pcb
      acc.epfEmployee += p.epfEmployee
      acc.epfEmployer += p.epfEmployer
      acc.socsoEmployee += p.socsoEmployee
      acc.socsoEmployer += p.socsoEmployer
      acc.eisEmployee += p.eisEmployee
      acc.eisEmployer += p.eisEmployer
      acc.hrdf += p.hrdf
      return acc
    },
    {
      pcb: 0,
      epfEmployee: 0,
      epfEmployer: 0,
      socsoEmployee: 0,
      socsoEmployer: 0,
      eisEmployee: 0,
      eisEmployer: 0,
      hrdf: 0,
    },
  )

  return renderToBuffer(
    <PaymentSchedulePdfDocument
      organizationName={data.organizationName}
      period={periodLabel(data.run.periodYear, data.run.periodMonth)}
      payslips={data.payslips}
      totals={totals}
      generatedAt={new Date()}
    />,
  )
}
