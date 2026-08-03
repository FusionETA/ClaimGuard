import "server-only"

import JSZip from "jszip"
import { renderToBuffer } from "@react-pdf/renderer"

import {
  EmployeePayslipPdfDocument,
  type BulkPayslipPdfRow,
} from "@/components/admin/payroll-report-pdf-documents"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"
import { periodLabel, type PayslipData } from "@/modules/payroll/domain/runs"

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
/**
 * How many employees to hydrate / render at a time. Small enough that a
 * batch of CPU-heavy @react-pdf renders can't monopolise the event loop
 * for long before we yield, large enough that the overall run stays fast.
 */
const RENDER_BATCH_SIZE = 12

/**
 * Run `fn` over `items` in batches of `batchSize`, awaiting each batch
 * before starting the next and yielding to the event loop (`setImmediate`)
 * between batches. Preserves input order in the returned array. This keeps
 * a large payroll run from starving the single Node process — both the
 * concurrent DB hydration and the CPU-bound PDF rendering — so concurrent
 * requests (navigation, other admins) stay responsive.
 */
async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const results = await Promise.all(batch.map(fn))
    out.push(...results)
    if (i + batchSize < items.length) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return out
}

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
  // Batched (see mapInBatches) so a large run doesn't fire hundreds of
  // concurrent queries at once and starve the connection pool that the
  // rest of the app — including an admin navigating away — is sharing.
  const enriched = await mapInBatches(data.payslips, RENDER_BATCH_SIZE, async (p) => {
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
  })

  const issueDate = new Date(
    data.run.periodYear,
    data.run.periodMonth,
    0, // day 0 of next month = last day of period month
  )
  const period = periodLabel(data.run.periodYear, data.run.periodMonth)
  const generatedAt = new Date()
  const periodTag = `${String(data.run.periodMonth).padStart(2, "0")}-${data.run.periodYear}`

  // Render employees' PDFs in small batches, yielding to the event loop
  // between batches. @react-pdf's renderToBuffer is CPU-bound and runs
  // long synchronous bursts on the single Node process; rendering every
  // employee at once (the old Promise.all) monopolises the CPU so
  // unrelated requests — e.g. an admin clicking "Back" right after
  // approving a run, which triggers a server render — can't get serviced
  // until the whole batch finishes, and the page appears to hang. The
  // setImmediate yield inside mapInBatches gives those requests CPU time.
  // Mirrors the between-report-kinds yield in payroll-run.service.ts.
  const pdfBuffers = await mapInBatches(enriched, RENDER_BATCH_SIZE, (payslip) =>
    renderToBuffer(
      <EmployeePayslipPdfDocument
        organizationName={data.organizationName}
        period={period}
        issueDate={issueDate}
        payslip={payslip}
        generatedAt={generatedAt}
      />,
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
 * Render ONE employee's payslip PDF on demand — the same
 * `EmployeePayslipPdfDocument` the bulk ZIP bundles, but for a single
 * payslip and decoupled from the ZIP. Used by the employee-portal
 * single-payslip download so an employee can pull their own PDF without
 * the whole run's bulk ZIP being generated/stored first.
 *
 * Enriches the payslip with the same per-employee identity + calendar-
 * year YTD the dense payslip PDF needs (mirrors the per-row enrichment
 * inside `renderBulkPayslipsPdf`).
 */
export async function renderEmployeePayslipPdf(input: {
  organizationName: string
  periodYear: number
  periodMonth: number
  payslip: PayslipData
}): Promise<Buffer> {
  const [identity, ytd] = await Promise.all([
    payslipRepository.getPayslipHeaderIdentity({
      employeeProfileId: input.payslip.employeeProfileId,
    }),
    payslipRepository.getYtdSummaryThroughPeriod({
      employeeProfileId: input.payslip.employeeProfileId,
      year: input.periodYear,
      month: input.periodMonth,
    }),
  ])

  const enriched: BulkPayslipPdfRow = {
    ...input.payslip,
    lineItemCount: input.payslip.lineItems.length,
    identity,
    ytd,
  }

  const issueDate = new Date(
    input.periodYear,
    input.periodMonth,
    0, // day 0 of next month = last day of period month
  )
  const period = periodLabel(input.periodYear, input.periodMonth)

  return renderToBuffer(
    <EmployeePayslipPdfDocument
      organizationName={input.organizationName}
      period={period}
      issueDate={issueDate}
      payslip={enriched}
      generatedAt={new Date()}
    />,
  )
}

/**
 * Filename for one payslip inside the ZIP. Strips Windows-illegal
 * characters and collapses whitespace to underscores so the name
 * survives round-tripping through email + chat clients that escape
 * spaces awkwardly.
 */
export function buildPayslipFileName(input: {
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

export function sanitise(raw: string): string {
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
