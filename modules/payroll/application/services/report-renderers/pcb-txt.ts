import "server-only"

import {
  loadStatutoryRunPayload,
  normaliseNewIc,
  padLeft,
  padRight,
  padZero,
  pcbWifeCode,
  taxRefWithoutWifeCode,
  toSen,
} from "@/modules/payroll/application/services/report-renderers/shared"

/**
 * PCB / MTD TXT — LHDN CP39 batch contribution format.
 *
 * One header row + N detail rows, fixed-width.
 *
 * HEADER (57 chars):
 *   01      "H"
 *   02-11   HQ Employer No        (10 num, zero-pad right)
 *   12-21   Branch Employer No    (10 num, zero-pad right)
 *   22-25   Deduction Year        (4 num)
 *   26-27   Deduction Month       (2 num, 01-12)
 *   28-37   Total PCB sen         (10 num, zero-pad right)
 *   38-42   PCB Record Count      (5 num, zero-pad right)
 *   43-52   Total CP38 sen        (10 num, zero-pad right)
 *   53-57   CP38 Record Count     (5 num, zero-pad right) *
 *
 *   * The LHDN PDF has a typo showing 43-57 for both columns 8 & 9;
 *     the example data confirms 53-57. We follow the example.
 *
 * DETAIL (136 chars):
 *   01      "D"
 *   02-11   Tax Reference         (10 num, zero-pad, no SG/OG prefix)
 *   12      Wife Code             (0 male/single-female, 1-9 married woman)
 *   13-72   Employee Name         (60 alphanum, left, space-pad)
 *   73-84   Old IC                (12 alphanum, left, space-pad — blank if N/A)
 *   85-96   New IC                (12 numeric, blank if foreign)
 *   97-108  Passport No           (12 alphanum, left, space-pad — blank if local)
 *   109-110 Country Code          (2 alpha, blank if local)
 *   111-118 PCB Amount sen        (8 num, zero-pad right)
 *   119-126 CP38 Amount sen       (8 num, zero-pad right)
 *   127-136 Employee/Payroll No   (10 alphanum, left, space-pad)
 *
 * Lines: CRLF.
 *
 * NB: The Altomate code we ported from had a bug putting the New IC
 * value into BOTH the Old IC and New IC slots. We deliberately do NOT
 * replicate that — Old IC is blank-padded when not provided.
 */
export async function renderPcbTxt(input: {
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

  // Extract the numeric portion of the LHDN E-number (strip "E" prefix,
  // dashes, spaces). The company info row stores this as `employerTin`
  // for now — admin enters it on the Payroll Settings → Company Info
  // tab. If a separate "HQ" code isn't configured, fall back to the
  // same value (per LHDN guidance — branch === HQ for single-branch
  // employers).
  const rawEmployerNo = (payload.companyInfo?.employerTin ?? "").replace(
    /[^0-9]/g,
    "",
  )
  if (rawEmployerNo.length === 0) {
    throw new Error(
      "Employer LHDN E-number is missing. Set it in Payroll Settings → Company Info before generating the PCB TXT.",
    )
  }
  // No separate HQ/branch fields on PayrollCompanyInfo today — use the
  // same value for both. We can add a dedicated field later.
  const employerNoHq = rawEmployerNo
  const employerNo = rawEmployerNo

  // Build the detail rows first so we can compute the header totals.
  const detailLines: string[] = []
  let pcbTotalSen = 0
  let pcbCount = 0
  let cp38TotalSen = 0
  let cp38Count = 0

  for (const row of payload.rows) {
    // LHDN wants any row with PCB > 0 OR CP38 > 0. A CP38-only row
    // (no formula-calculated PCB but with a court-ordered arrears
    // installment) must still be submitted.
    // Additional PCB (Employment Income) is remitted through the STANDARD
    // PCB field, not a dedicated column — so fold it into the row's PCB
    // before encoding. CP38 arrears keep their own column (below).
    const rowPcb = row.payslip.pcb + (row.payslip.voluntaryPcb ?? 0)
    const rowCp38 = row.payslip.cp38
    if (rowPcb <= 0 && rowCp38 <= 0) continue

    const employeeCode = row.employeeCode.trim()
    const employeeRef = employeeCode || row.employeeName
    const taxRef = taxRefWithoutWifeCode(row.incomeTaxNumber)
    if (taxRef.length === 0) {
      throw new Error(
        `PCB TXT cannot be generated: ${employeeRef} is missing an income tax number.`,
      )
    }
    const wifeCode = pcbWifeCode({
      taxRef: row.incomeTaxNumber,
      gender: row.gender,
      maritalStatus: row.maritalStatus,
    })

    // Identification: locals carry New IC, foreigners carry Passport +
    // Country Code.
    const isMalaysian =
      (row.nationality ?? "").toLowerCase() === "malaysian" || row.hasPr
    const newIc = isMalaysian ? normaliseNewIc(row.idNumber) : ""
    const passport = !isMalaysian ? normalisePassport(row.idNumber) : ""
    if (isMalaysian && newIc.length === 0) {
      throw new Error(
        `PCB TXT cannot be generated: ${employeeRef} is missing a New IC number.`,
      )
    }
    if (!isMalaysian && passport.length === 0) {
      throw new Error(
        `PCB TXT cannot be generated: ${employeeRef} is missing a passport number.`,
      )
    }
    if (employeeCode.length === 0) {
      throw new Error(
        `PCB TXT cannot be generated: ${row.employeeName} is missing an employee/payroll number.`,
      )
    }
    // Country code not yet captured separately on PayrollProfile —
    // leave blank. Admin can dry-run + we add it if LHDN rejects.
    const countryCode = ""

    const pcbSen = toSen(rowPcb)
    if (pcbSen > 0) {
      pcbTotalSen += pcbSen
      pcbCount += 1
    }
    const cp38Sen = toSen(rowCp38)
    if (cp38Sen > 0) {
      cp38TotalSen += cp38Sen
      cp38Count += 1
    }

    const detail =
      "D" +
      padZero(taxRef.length === 0 ? "0" : taxRef, 10) +
      wifeCode +
      padRight(row.employeeName, 60) +
      padRight("", 12) + // Old IC — intentionally blank (see header comment)
      padRight(newIc, 12) +
      padRight(passport, 12) +
      padRight(countryCode, 2) +
      padZero(pcbSen, 8) +
      padZero(cp38Sen, 8) +
      padRight(employeeCode, 10)

    if (detail.length !== 136) {
      detailLines.push(detail.padEnd(136, " ").slice(0, 136))
    } else {
      detailLines.push(detail)
    }
  }

  const header =
    "H" +
    padZero(employerNoHq, 10) +
    padZero(employerNo, 10) +
    padZero(payload.run.periodYear, 4) +
    padLeft(String(payload.run.periodMonth).padStart(2, "0"), 2) +
    padZero(pcbTotalSen, 10) +
    padZero(pcbCount, 5) +
    padZero(cp38TotalSen, 10) +
    padZero(cp38Count, 5)

  // Defensive resize — header must be exactly 57 chars.
  const headerLine =
    header.length === 57 ? header : header.padEnd(57, " ").slice(0, 57)

  const allLines = [headerLine, ...detailLines]
  const text = allLines.join("\r\n") + "\r\n"
  return Buffer.from(text, "utf8")
}

function normalisePassport(idNumber: string | null | undefined): string {
  return (idNumber ?? "").replace(/[^0-9A-Za-z]/g, "")
}
