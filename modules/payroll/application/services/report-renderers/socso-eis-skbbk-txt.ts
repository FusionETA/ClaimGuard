import "server-only"

import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import {
  loadStatutoryRunPayload,
  normaliseNewIc,
  padLeft,
  padRight,
  senDigits,
} from "@/modules/payroll/application/services/report-renderers/shared"

/**
 * SOCSO + EIS + SKBBK combined contribution TXT — 278-char fixed-width
 * per PERKESO **ASSIST 2.0** spec (effective 1 Jun 2026, "TEXTFILE
 * STRUCTURE FOR COMBINE CONTRIBUTION v2.0"). Adds the new SKBBK
 * (Skim LINDUNG 24 Jam / Non-Employment Injury Security Scheme)
 * employee contribution column into what used to be filler bytes.
 *
 * Column layout (1-indexed positions inclusive):
 *
 *   001-012 Employer Code             (alphanum, left, space-pad)
 *   013-032 MyCoID / SSM Number       (alphanum, left, space-pad)
 *   033-044 IC / SOCSO Foreign Worker (alphanum, left, space-pad)
 *   045-194 Employee Name             (alphanum, left, space-pad)
 *   195-200 Month Contribution        (numeric, MMYYYY)
 *   201-214 Employee Salary           (numeric sen, right, space-pad)
 *   215-220 SOCSO Employer share      (numeric sen, right, space-pad)
 *   221-226 SOCSO Employee share      (numeric sen, right, space-pad)
 *   227-232 EIS Employer share        (numeric sen, right, space-pad)
 *   233-238 EIS Employee share        (numeric sen, right, space-pad)
 *   239-244 SKBBK Employee share      (numeric sen, right, space-pad)  ← new in v2.0
 *   245-258 Filler 1                  (blank spaces, was 20 chars in v1)
 *   259-278 Filler 2                  (blank spaces)
 *
 * Total: 278 chars per row, CRLF line endings. Backwards-compatible
 * with v1 parsers — they ignored the bytes that now carry SKBBK as
 * filler.
 *
 * Grace window: PERKESO accepts either v1 (no SKBBK) or v2 (with
 * SKBBK) text files from Jun 2026 through Sep 2026; v2 becomes
 * mandatory from Oct 2026. The two renderers are kept in lock-step
 * (identical employer/header logic) so the only behavioural delta is
 * the SKBBK column — diff them when fixing one and the other almost
 * certainly needs the same fix.
 */
export async function renderSocsoEisSkbbkTxt(input: {
  runId: string
  /// Already-authorised org that owns the run (threaded from
  /// `renderPayrollReport`). Replaces the old admin-session read.
  organizationId: string
}): Promise<Buffer> {
  const payload = await loadStatutoryRunPayload({
    runId: input.runId,
    organizationId: input.organizationId,
  })
  if (!payload) throw new Error("Payroll run not found.")

  const employerCode = payload.companyInfo?.perkesoEmployerCode ?? ""
  const myCoId = payload.companyInfo?.registrationNo ?? ""
  if (employerCode.trim().length === 0) {
    throw new Error(
      "PERKESO Employer Code is missing. Set it in Payroll Settings → Company Info before generating the SOCSO + EIS + SKBBK file.",
    )
  }

  const mm = String(payload.run.periodMonth).padStart(2, "0")
  const yyyy = String(payload.run.periodYear)
  const monthContribution = `${mm}${yyyy}`

  const lines: string[] = []
  for (const row of payload.rows) {
    // Skip employees with no SOCSO + no EIS + no SKBBK — nothing to
    // remit. SKBBK is included here because some pre-Jun-2026
    // foreign-worker rows have SOCSO=0/EIS=0 historically but will
    // pick up SKBBK from Jun 2026 onwards.
    if (
      row.payslip.socsoEmployer === 0 &&
      row.payslip.socsoEmployee === 0 &&
      row.payslip.eisEmployer === 0 &&
      row.payslip.eisEmployee === 0 &&
      (row.payslip.skbbkEmployee ?? 0) === 0
    ) {
      continue
    }

    const isLocalOrPr = isMalaysianNationality(row.nationality) || row.hasPr
    const identification = isLocalOrPr
      ? normaliseNewIc(row.idNumber)
      : row.socsoNumber ?? row.ssfwNumber ?? normaliseNewIc(row.idNumber)

    const line =
      padRight(employerCode, 12) +
      padRight(myCoId, 20) +
      padRight(identification, 12) +
      padRight(row.employeeName, 150) +
      monthContribution +
      padLeft(senDigits(row.payslip.grossPay), 14) +
      padLeft(senDigits(row.payslip.socsoEmployer), 6) +
      padLeft(senDigits(row.payslip.socsoEmployee), 6) +
      padLeft(senDigits(row.payslip.eisEmployer), 6) +
      padLeft(senDigits(row.payslip.eisEmployee), 6) +
      padLeft(senDigits(row.payslip.skbbkEmployee ?? 0), 6) + // SKBBK
      " ".repeat(14) + // Filler 1 (was 20 in v1, now 14 after SKBBK)
      " ".repeat(20) // Filler 2

    if (line.length !== 278) {
      lines.push(line.padEnd(278, " ").slice(0, 278))
    } else {
      lines.push(line)
    }
  }

  const text = lines.join("\r\n") + (lines.length > 0 ? "\r\n" : "")
  return Buffer.from(text, "utf8")
}
