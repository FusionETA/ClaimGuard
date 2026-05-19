import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  loadStatutoryRunPayload,
  normaliseNewIc,
  padLeft,
  padRight,
  toSen,
} from "@/modules/payroll/application/services/report-renderers/shared"

/**
 * SOCSO + EIS combined contribution TXT — 278-char fixed-width per
 * PERKESO spec v1.0 (22 Jul 2022, "TEXTFILE STRUCTURE FOR COMBINE
 * CONTRIBUTION").
 *
 * Column layout (1-indexed positions inclusive):
 *
 *   01-012  Employer Code            (alphanum, left, space-pad)
 *   013-032 MyCoID / SSM Number      (alphanum, left, space-pad)
 *   033-044 IC / SOCSO Foreign Worker (alphanum, left, space-pad)
 *   045-194 Employee Name            (alphanum, left, space-pad)
 *   195-200 Month Contribution       (numeric, MMYYYY)
 *   201-214 Employee Salary          (numeric sen, right, space-pad)
 *   215-220 SOCSO Employer share     (numeric sen, right, space-pad)
 *   221-226 SOCSO Employee share     (numeric sen, right, space-pad)
 *   227-232 EIS Employer share       (numeric sen, right, space-pad)
 *   233-238 EIS Employee share       (numeric sen, right, space-pad)
 *   239-258 Filler 1                 (blank spaces)
 *   259-278 Filler 2                 (blank spaces)
 *
 * Total: 278 chars per row, CRLF line endings.
 *
 * The employer code + MyCoID come from `PayrollCompanyInfo`. The
 * Foreign Worker number column uses `ssfwNumber` for non-Malaysian
 * non-PR employees (per spec), and falls back to IC otherwise.
 */
export async function renderSocsoEisTxt(input: {
  runId: string
}): Promise<Buffer> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const payload = await loadStatutoryRunPayload({
    runId: input.runId,
    organizationId: orgId,
  })
  if (!payload) throw new Error("Payroll run not found.")

  const employerCode = payload.companyInfo?.referenceNo ?? ""
  const myCoId = payload.companyInfo?.registrationNo ?? ""

  const mm = String(payload.run.periodMonth).padStart(2, "0")
  const yyyy = String(payload.run.periodYear)
  const monthContribution = `${mm}${yyyy}`

  const lines: string[] = []
  for (const row of payload.rows) {
    // Skip employees with no SOCSO + no EIS — nothing to remit.
    if (
      row.payslip.socsoEmployer === 0 &&
      row.payslip.socsoEmployee === 0 &&
      row.payslip.eisEmployer === 0 &&
      row.payslip.eisEmployee === 0
    ) {
      continue
    }

    // Identification: New IC for locals/PRs, SSFW for foreigners.
    const isMalaysian =
      (row.nationality ?? "").toLowerCase() === "malaysian" || row.hasPr
    const identification = isMalaysian
      ? normaliseNewIc(row.idNumber)
      : row.ssfwNumber ?? normaliseNewIc(row.idNumber)

    const line =
      padRight(employerCode, 12) +
      padRight(myCoId, 20) +
      padRight(identification, 12) +
      padRight(row.employeeName, 150) +
      monthContribution +
      padLeft(String(toSen(row.payslip.grossPay)), 14) +
      padLeft(String(toSen(row.payslip.socsoEmployer)), 6) +
      padLeft(String(toSen(row.payslip.socsoEmployee)), 6) +
      padLeft(String(toSen(row.payslip.eisEmployer)), 6) +
      padLeft(String(toSen(row.payslip.eisEmployee)), 6) +
      " ".repeat(20) + // Filler 1
      " ".repeat(20) // Filler 2

    if (line.length !== 278) {
      // Defensive — never ship a malformed row. Pad/truncate to 278.
      lines.push(line.padEnd(278, " ").slice(0, 278))
    } else {
      lines.push(line)
    }
  }

  const text = lines.join("\r\n") + (lines.length > 0 ? "\r\n" : "")
  return Buffer.from(text, "utf8")
}
