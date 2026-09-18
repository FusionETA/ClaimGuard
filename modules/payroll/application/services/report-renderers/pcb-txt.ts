import "server-only"

import { nationalityToCountryCode } from "@/lib/nationality-country-codes"
import {
  loadStatutoryRunPayload,
  looksLikePlaceholderId,
  normaliseNewIc,
  normaliseTaxRef,
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
 *
 *   NB: LHDN's validator reads 02-12 as ONE 11-digit TIN — the tax
 *   reference with the wife code as its last digit. So the number on
 *   the profile must already be 11 digits and we never synthesise the
 *   12th character; see the check in the loop below.
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
  // A dummy E-number passes the "not empty" check above and then fails
  // LHDN's validator on the header, which rejects the whole submission
  // before it looks at a single employee ("No E (HQ) 1234567890 not
  // exist", Aug 2026). Catch the obvious placeholders here instead.
  if (looksLikePlaceholderId(rawEmployerNo)) {
    throw new Error(
      `Employer LHDN E-number "${payload.companyInfo?.employerTin}" looks like a placeholder. Enter the real E-number in Payroll Settings → Company Info — LHDN rejects the whole file on the header otherwise.`,
    )
  }
  // No separate HQ/branch fields on PayrollCompanyInfo today — use the
  // same value for both. We can add a dedicated field later.
  const employerNoHq = rawEmployerNo
  const employerNo = rawEmployerNo

  // Build the detail rows first so we can compute the header totals.
  //
  // Data problems are COLLECTED, not thrown on sight: an admin fixing
  // one employee at a time would need one download per bad row. We skip
  // the offending row, keep checking, and report every one together.
  const dataErrors: string[] = []
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
    // LHDN reads positions 2-12 as ONE 11-digit TIN: our 10-digit tax
    // reference plus the wife code. So the stored number must already
    // be 11 digits, and we must not invent the 11th.
    //
    // It used to be inferred from gender + marital status whenever the
    // stored value was shorter. A number saved without its leading zero
    // ("IG2661447020" instead of "IG02661447020") therefore shifted one
    // place left AND picked up a guessed digit on the end — a married
    // woman got a "1". The Aug 2026 submission came back with nine
    // "Tax Identification Number ... does not exist" errors, one for
    // every employee whose TIN begins with zero.
    const taxDigits = normaliseTaxRef(row.incomeTaxNumber)
    if (taxDigits.length === 0) {
      dataErrors.push(`${employeeRef} — no income tax number on file.`)
      continue
    }
    if (taxDigits.length !== 11) {
      dataErrors.push(
        `${employeeRef} — income tax number "${row.incomeTaxNumber}" has ${taxDigits.length} digits, LHDN expects 11 (keep any leading zero, e.g. IG02661447020).`,
      )
      continue
    }
    const taxRef = taxRefWithoutWifeCode(row.incomeTaxNumber)
    const wifeCode = pcbWifeCode({
      taxRef: row.incomeTaxNumber,
      gender: row.gender,
      maritalStatus: row.maritalStatus,
    })

    // Identification: locals carry New IC, foreigners carry Passport +
    // Country Code. A PASSPORT id type wins over whatever the
    // nationality string says — an employee marked "Malaysian" while
    // holding a passport used to take the local branch, where
    // `normaliseNewIc` strips the letters and writes the remains into
    // the IC field ("Z5712674" → "5712674", Aug 2026 record 101).
    const isMalaysian =
      row.idType !== "PASSPORT" &&
      ((row.nationality ?? "").toLowerCase() === "malaysian" || row.hasPr)
    const newIc = isMalaysian ? normaliseNewIc(row.idNumber) : ""
    const passport = !isMalaysian ? normalisePassport(row.idNumber) : ""
    if (isMalaysian && newIc.length === 0) {
      dataErrors.push(`${employeeRef} — no New IC number on file.`)
      continue
    }
    // A Malaysian New IC is always 12 digits. Anything else is some
    // other document in the IC field, and LHDN answers with "New
    // Identification No. ... does not match".
    if (isMalaysian && newIc.length !== 12) {
      dataErrors.push(
        `${employeeRef} — New IC "${row.idNumber}" is ${newIc.length} digits, not 12. If this is a passport, set the ID type to Passport and the nationality to the employee's own country.`,
      )
      continue
    }
    if (!isMalaysian && passport.length === 0) {
      dataErrors.push(`${employeeRef} — no passport number on file.`)
      continue
    }
    if (employeeCode.length === 0) {
      dataErrors.push(`${row.employeeName} — no employee/payroll number.`)
      continue
    }
    // Country code (positions 109-110) belongs to the passport, so it
    // is derived from the employee's nationality — no second field for
    // the admin to fill and keep in step. Blank for Malaysians, and
    // blank when the nationality isn't one we can map, which is what
    // this field held for everyone until now.
    const countryCode = isMalaysian
      ? ""
      : nationalityToCountryCode(row.nationality)

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
      padZero(taxRef, 10) + // guaranteed 10 digits by the check above
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

  // One error naming every bad row, so the admin fixes the lot in a
  // single pass instead of rediscovering the next one per download.
  if (dataErrors.length > 0) {
    throw new Error(
      `PCB TXT cannot be generated — ${dataErrors.length} employee${dataErrors.length === 1 ? "" : "s"} need fixing first:\n\n${dataErrors.map((e) => `• ${e}`).join("\n")}`,
    )
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
