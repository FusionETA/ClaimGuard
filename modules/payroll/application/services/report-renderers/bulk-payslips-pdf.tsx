import "server-only"

import JSZip from "jszip"
import { renderToBuffer } from "@react-pdf/renderer"

import { EmployeePayslipPdfDocument } from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"
import { periodLabel } from "@/modules/payroll/domain/runs"

/**
 * Bulk payslip download — one PDF per employee, all bundled into a
 * single ZIP. Per Nicholas's request (2026-06): finance teams want to
 * forward individual payslips to specific employees over chat / email
 * without having to split a giant concatenated PDF first.
 *
 * Inside the ZIP each file is named
 *   `<EmployeeID>_<EmployeeName>_<MM-YYYY>.pdf`
 * with the employee name sanitised so it survives Windows + macOS
 * filesystems (Windows-illegal characters stripped, whitespace
 * collapsed to underscores). This keeps the names sortable +
 * recognisable when an admin opens the ZIP.
 */
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

  // Same hydration pass as before: per-employee identity + YTD
  // through this period are needed by the payslip header + matrix.
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
      return { ...p, identity, ytd }
    }),
  )

  const issueDate = new Date(
    data.run.periodYear,
    data.run.periodMonth,
    0, // day 0 of next month = last day of period month
  )
  const period = periodLabel(data.run.periodYear, data.run.periodMonth)
  const generatedAt = new Date()
  const periodTag = `${String(data.run.periodMonth).padStart(2, "0")}-${data.run.periodYear}`

  // Render every employee's PDF concurrently. @react-pdf is CPU-heavy
  // so we may want to throttle once headcount goes north of ~200, but
  // for typical SME runs (≤ 100 employees) Promise.all keeps the
  // overall download under a few seconds and is fine.
  const pdfBuffers = await Promise.all(
    enriched.map((payslip) =>
      renderToBuffer(
        <EmployeePayslipPdfDocument
          organizationName={data.organizationName}
          period={period}
          issueDate={issueDate}
          payslip={payslip}
          generatedAt={generatedAt}
        />,
      ),
    ),
  )

  const zip = new JSZip()
  // Dedupe file names: when two employees share an ID (legacy data) or
  // a payroll profile has been duplicated, append `_2`, `_3`, … so the
  // ZIP doesn't silently overwrite earlier entries.
  const used = new Set<string>()
  for (let i = 0; i < enriched.length; i += 1) {
    const payslip = enriched[i]
    const baseName = buildPayslipFileName({
      employeeId: payslip.snapshotEmployeeId,
      employeeName: payslip.snapshotName,
      periodTag,
    })
    let name = baseName
    let dedupe = 2
    while (used.has(name)) {
      name = baseName.replace(/\.pdf$/, `_${dedupe}.pdf`)
      dedupe += 1
    }
    used.add(name)
    zip.file(name, pdfBuffers[i])
  }

  const zipBytes = await zip.generateAsync({
    type: "nodebuffer",
    // PDFs are already heavily compressed internally so the extra
    // savings are small, but matching the standard DEFLATE format
    // (vs STORE) keeps every file-explorer tool happy.
    compression: "DEFLATE",
  })
  return zipBytes
}

/**
 * Filename for one payslip inside the ZIP. Strips Windows-illegal
 * characters and collapses whitespace to underscores so the name
 * survives round-tripping through email + chat clients that escape
 * spaces awkwardly.
 */
function buildPayslipFileName(input: {
  employeeId: string
  employeeName: string
  periodTag: string
}): string {
  const id = sanitise(input.employeeId) || "Employee"
  const name = sanitise(input.employeeName) || "Unnamed"
  return `${id}_${name}_${input.periodTag}.pdf`
}

// Characters Windows rejects in a filename. Built as a character array
// instead of a regex literal so this file is robust against tool-edit
// escape weirdness around the backslash.
const FORBIDDEN_FILENAME_CHARS = new Set([
  "<",
  ">",
  ":",
  '"',
  "/",
  "\\",
  "|",
  "?",
  "*",
])

function sanitise(raw: string): string {
  let stripped = ""
  for (const ch of raw) {
    if (FORBIDDEN_FILENAME_CHARS.has(ch)) continue
    stripped += ch
  }
  return stripped
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
}
