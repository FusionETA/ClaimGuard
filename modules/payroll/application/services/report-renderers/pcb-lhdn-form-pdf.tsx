import "server-only"

import JSZip from "jszip"
import { renderToBuffer } from "@react-pdf/renderer"

import { PcbCalculationDetailsPdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageDataForOrg } from "@/modules/payroll/application/services/payroll-run.service"
import { periodLabel } from "@/modules/payroll/domain/runs"
import { sanitiseFilenamePart } from "@/lib/filename"

/**
 * Renders the LHDN MTD §E worksheet — one PDF per employee, all
 * bundled into a single ZIP. Each employee PDF uses the official LHDN
 * form layout: dark navy header bar, numbered sections, each LHDN
 * variable in its own table card with abbreviation + full
 * description + amount, and inline formula expansions for P / Yearly
 * Tax / Current Month PCB.
 *
 * Audit-ready format. An LHDN officer familiar with the published
 * MTD worksheet should be able to read it without explanation.
 *
 * ZIP-of-individual-PDFs (was a single combined PDF pre 2026-07) so
 * finance can forward one employee's worksheet without splitting a
 * giant concatenated PDF first — same rationale as bulk-payslips.
 */
export async function renderPcbLhdnFormPdf(input: {
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
      "Run payroll before downloading the PCB Calculation Details.",
    )
  }

  const period = periodLabel(data.run.periodYear, data.run.periodMonth)
  const periodTag = `${String(data.run.periodMonth).padStart(2, "0")}-${data.run.periodYear}`
  const generatedAt = new Date()

  const pdfBuffers = await Promise.all(
    data.payslips.map((payslip) =>
      renderToBuffer(
        <PcbCalculationDetailsPdfDocument
          organizationName={data.organizationName}
          period={period}
          payslips={[payslip]}
          generatedAt={generatedAt}
        />,
      ),
    ),
  )

  const zip = new JSZip()
  const used = new Set<string>()
  for (let i = 0; i < data.payslips.length; i += 1) {
    const p = data.payslips[i]
    const idPart = sanitiseFilenamePart(p.snapshotEmployeeId) || "Employee"
    const namePart = sanitiseFilenamePart(p.snapshotName) || "Unnamed"
    const base = `${idPart}_${namePart}_${periodTag}.pdf`
    let name = base
    let n = 2
    while (used.has(name)) {
      name = base.replace(/\.pdf$/, `_${n}.pdf`)
      n += 1
    }
    used.add(name)
    zip.file(name, pdfBuffers[i])
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}
