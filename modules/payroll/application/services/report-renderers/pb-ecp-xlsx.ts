import "server-only"

import * as XLSX from "xlsx"

import { findBankByName } from "@/modules/payroll/domain/malaysian-banks"
import type { IdType } from "@/modules/payroll/domain/models"
import {
  getPayrollDisbursementRowsForOrg,
} from "@/modules/payroll/application/services/payroll-run.service"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"

/**
 * Public Bank Berhad ECP Payroll Excel renderer.
 *
 * Produces an .xlsx file matching the PB ECP Bulk Payroll upload spec
 * (PB enterprise User Guide v1.2). Layout:
 *
 *   Row 1: cell A1 = "PAYMENT DATE: (DD/MM/YYYY)", cell B1 = actual date
 *   Row 2: column headers (21 columns A–U)
 *   Row 3: format hints "(M) - Char: 3 - A" etc.
 *   Row 4+: one row per employee
 *
 * Columns (per the template):
 *   A  Payment Type/Mode (PBB/IBG/REN)             — mandatory, 3 alpha
 *   B  Beneficiary Account No.                     — mandatory, 20 num
 *   C  BIC                                         — mandatory, 11 alphanum
 *   D  Beneficiary Full Name                       — mandatory, 120 alphanum
 *   E  ID Type (NI/OI/BR/PL/ML/PP)                 — optional, 2 alpha
 *   F  Beneficiary ID No / Passport                — optional, 29 alphanum
 *   G  Payment Amount (with 2 decimal points)      — mandatory, 18 num
 *   H  Recipient Reference                         — mandatory, 20 alphanum
 *   I  Other Payment Details                       — optional, 20 alphanum
 *   J  Beneficiary Email 1                         — optional, 70 alphanum
 *   K  Beneficiary Email 2                         — optional, 70 alphanum
 *   L  Beneficiary Mobile No. 1                    — optional, 15 num
 *   M  Beneficiary Mobile No. 2                    — optional, 15 num
 *   N  Joint Beneficiary Name                      — optional (payroll: blank)
 *   O  Joint Beneficiary ID No.                    — optional (payroll: blank)
 *   P  Joint ID Type                               — optional (payroll: blank)
 *   Q-U  Email Content Line 1-5                    — optional (payroll: blank)
 *
 * Filename: `{10-digit account}PR{DDMMYY}{NN}.xlsx` per the spec.
 */
export async function renderPbEcpXlsx(input: {
  runId: string
  /// Already-authorised org that owns the run (threaded from
  /// `renderPayrollReport`). Replaces the old admin-session read.
  organizationId: string
  /// Payment date for the upload. Defaults to the last day of the
  /// run's period month when not specified. PB ECP accepts up to 60
  /// days future-dated.
  paymentDate?: Date
}): Promise<Buffer> {
  const orgId = input.organizationId

  // Load settings + disbursement rows in parallel.
  const [settings, data] = await Promise.all([
    payrollSettingsRepository.getByOrgId(orgId),
    getPayrollDisbursementRowsForOrg({ runId: input.runId, organizationId: orgId }),
  ])

  if (!data) throw new Error("Payroll run not found.")

  const payorAccountNo = (settings?.ecpPayorAccountNo ?? "").replace(
    /[^0-9]/g,
    "",
  )
  if (payorAccountNo.length === 0) {
    throw new Error(
      "Public Bank payor account number is not configured. Set it under Payroll Settings → Bank → ECP Payor Account before generating the PB ECP file.",
    )
  }
  if (payorAccountNo.length !== 10) {
    throw new Error(
      `Public Bank payor account number must be exactly 10 digits (currently ${payorAccountNo.length}). Update it under Payroll Settings → Bank.`,
    )
  }

  // Payment date — default to last day of the period month.
  const paymentDate =
    input.paymentDate ?? new Date(data.run.periodYear, data.run.periodMonth, 0)

  // ─── Build the worksheet rows ────────────────────────────────────

  // PB ECP's validator compares the header block (rows 1-3) against its
  // exact template — any drift (a trailing space, a truncated label, a
  // different format hint) trips "Header: … is invalid". These strings
  // are copied verbatim from a PB-accepted file. Do NOT "tidy" them.
  const ID_TYPE_HEADER =
    "ID Type:\n\nFor Intrabank & IBG\nNI, OI, BR, PL, ML, PP\n\nFor Rentas\nNI, OI, BR, OT"

  /// Row 1: PAYMENT DATE label. B1 (the date itself) is written AFTER
  /// the sheet is built, as a real Excel date serial — PB rejects a
  /// text date ("Payment Date is invalid"). Placeholder here.
  const row1: (string | number | null)[] = [
    "PAYMENT DATE :\n(DD/MM/YYYY)",
    "",
  ]
  while (row1.length < 21) row1.push(null)

  /// Row 2: headers (verbatim PB template).
  const row2: string[] = [
    "Payment Type/ Mode : PBB/IBG/REN",
    "Bene Account No.",
    "BIC",
    "Bene Full Name",
    ID_TYPE_HEADER,
    "Bene Identification No / Passport",
    "Payment Amount (with 2 decimal points)",
    "Recipient Reference",
    "Other Payment Details",
    "Bene Email 1",
    "Bene Email 2",
    "Bene Mobile No. 1",
    "Bene Mobile No. 2",
    "Joint Bene Name",
    "Joint Beneficiary Identification No.",
    `Joint ${ID_TYPE_HEADER}`,
    "E-mail Content Line 1",
    "E-mail Content Line 2",
    "E-mail Content Line 3",
    "E-mail Content Line 4",
    "E-mail Content Line 5",
  ]

  /// Row 3: format hints (verbatim PB template).
  const row3: string[] = [
    "(M) - Char: 3 - A",
    "(M) - Char:20 - N",
    "(M) - Char: 11 - A",
    "(M) - Char: 120 - A",
    "(O) - Char: 2 - A",
    "(O) - Char: 29 - AN",
    "(M) - Char: 18 - N",
    "(M) - Char: 20 - AN",
    "(O) - Char: 20 - AN",
    "(O) - Char: 70 - AN",
    "(O) - Char: 70 - AN",
    "(O) - Char: 15 - N",
    "(O) - Char: 15 - N",
    "(O) - Char: 120 - A",
    "(O) - Char: 29 - AN",
    "(O) - Char: 2 - A",
    "(O) - Char: 40 - AN",
    "(O) - Char: 40 - AN",
    "(O) - Char: 40 - AN",
    "(O) - Char: 40 - AN",
    "(O) - Char: 40 - AN",
  ]

  // ─── Detail rows (row 4+) ────────────────────────────────────────

  type DetailRow = (string | number | null)[]
  const detailRows: DetailRow[] = []

  // Reference label put in column H for every row — single value
  // shared across the file so the bank statement is readable.
  // PB ECP caps this at 20 chars. We use the 3-letter month so even
  // the longest month (September) stays within the budget:
  //   "SALARY SEP 2026" = 15 chars.
  const monthAbbr = abbreviateMonth(data.run.periodMonth)
  const reference = `SALARY ${monthAbbr} ${data.run.periodYear}`
    .toUpperCase()
    .slice(0, 20)

  // Track unmatched banks so we can flag a clear error rather than
  // ship an unusable file.
  const unmatchedBanks: string[] = []
  let totalAmount = 0

  for (const row of data.rows) {
    // Skip rows with no bank account number — bank can't process them.
    if (!row.accountNumber || row.accountNumber.trim().length === 0) {
      continue
    }
    if (row.netAmount <= 0) continue

    // Map free-text bank name → MalaysianBank entry.
    const bank = findBankByName(row.bankName)
    if (!bank) {
      unmatchedBanks.push(`${row.employeeName} (${row.bankName})`)
      continue
    }

    const { ecpIdType, ecpIdNo } = mapPbEcpId(row.idType, row.idNumber)
    totalAmount += row.netAmount
    detailRows.push([
      bank.ecpMode, // A
      row.accountNumber.replace(/[^0-9]/g, ""), // B
      bank.bic, // C
      row.accountHolderName || row.employeeName, // D
      ecpIdType, // E ID Type (NI = New IC, PP = Passport)
      ecpIdNo, // F Bene Identification No / Passport
      // G — amount as TEXT with exactly 2 decimals. A numeric cell would
      // drop a trailing zero (3108.10 → 3108.1) and PB rejects it.
      row.netAmount.toFixed(2), // G
      reference, // H
      `EMP ${row.employeeCode}`.slice(0, 20), // I
      "", "", // J, K — emails
      "", "", // L, M — mobiles
      "", "", "", // N, O, P — joint
      "", "", "", "", "", // Q-U — email content
    ])
  }

  if (unmatchedBanks.length > 0) {
    throw new Error(
      `Could not match the following employees' banks to a recognised Malaysian bank: ${unmatchedBanks.join("; ")}. Update the bank name on each affected employee's payroll profile.`,
    )
  }

  if (detailRows.length === 0) {
    throw new Error(
      "No disbursement rows to write — every employee is missing a bank account number or has zero net pay.",
    )
  }

  // ─── Footer: TOTAL row ───────────────────────────────────────────
  // PB validates a footer "TOTAL:" row. The total, like the per-row
  // amounts, is TEXT with exactly 2 decimals (a numeric total trips
  // "Footer: Total is invalid").
  const totalRow: (string | number | null)[] = ["TOTAL:"]
  while (totalRow.length < 6) totalRow.push("")
  totalRow.push(totalAmount.toFixed(2)) // G
  while (totalRow.length < 21) totalRow.push("")

  // ─── Assemble the workbook ───────────────────────────────────────

  const aoa = [row1, row2, row3, ...detailRows, totalRow]
  const sheet = XLSX.utils.aoa_to_sheet(aoa)

  // B1 — the payment date. PB rejects a text date; it must be a real
  // Excel date serial with a dd/mm/yyyy number format (matches a
  // PB-accepted file). Compute the serial from the local Y/M/D so a
  // timezone offset can't shift the day.
  sheet["B1"] = {
    t: "n",
    v: excelDateSerial(paymentDate),
    z: "dd/mm/yyyy",
  }

  // Set columns widths roughly matching the template so the
  // pre-upload preview in Excel is readable.
  ;(sheet["!cols"] as XLSX.ColInfo[]) = [
    { wch: 22 }, // A
    { wch: 22 }, // B
    { wch: 12 }, // C
    { wch: 30 }, // D
    { wch: 8 }, // E
    { wch: 24 }, // F
    { wch: 22 }, // G
    { wch: 22 }, // H
    { wch: 22 }, // I
    { wch: 24 }, // J
    { wch: 24 }, // K
    { wch: 16 }, // L
    { wch: 16 }, // M
    { wch: 22 }, // N
    { wch: 24 }, // O
    { wch: 12 }, // P
    { wch: 20 }, // Q-U
    { wch: 20 },
    { wch: 20 },
    { wch: 20 },
    { wch: 20 },
  ]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, "Payroll")

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  })
  return buffer as Buffer
}

/// `DDMMYY` for the filename + `DD/MM/YYYY` for the cell. PB ECP
/// accepts the latter inside the sheet.
/**
 * Map our `IdType` enum + id number to PB ECP's "ID Type" code + number.
 * PB codes: NI = New IC, OI = Old IC, BR = Business Reg, PL = Police,
 * ML = Military, PP = Passport.
 *
 * IMPORTANT: our enum values are NRIC / PASSPORT / ARMY_NO / POLICE_NO
 * (see `IdType` in domain/models) — NOT "IC". Matching on "IC" left the
 * ID Type column blank for every Malaysian. The mapping:
 *   NRIC → NI, PASSPORT → PP, POLICE_NO → PL, ARMY_NO → ML.
 * Both columns are optional in the spec — blank when no ID on file.
 */
function mapPbEcpId(
  idType: IdType | null,
  idNumber: string | null,
): { ecpIdType: string; ecpIdNo: string } {
  const raw = (idNumber ?? "").trim()
  if (raw.length === 0) return { ecpIdType: "", ecpIdNo: "" }

  const alnum = raw.replace(/[^0-9A-Za-z]/g, "").slice(0, 29)
  const digits = raw.replace(/[^0-9]/g, "").slice(0, 29)

  switch (idType) {
    case "NRIC":
      // New IC — digits only, no dashes.
      return { ecpIdType: "NI", ecpIdNo: digits }
    case "PASSPORT":
      return { ecpIdType: "PP", ecpIdNo: alnum }
    case "POLICE_NO":
      return { ecpIdType: "PL", ecpIdNo: alnum }
    case "ARMY_NO":
      return { ecpIdType: "ML", ecpIdNo: alnum }
    default:
      // Unknown / missing type — emit the number with no type code.
      return { ecpIdType: "", ecpIdNo: alnum }
  }
}

/**
 * Excel date serial (days since the 1899-12-30 epoch) for a date-only
 * value. Built from the date's LOCAL Y/M/D via `Date.UTC` so a timezone
 * offset can never shift it to the previous/next day.
 */
function excelDateSerial(d: Date): number {
  const utcMidnight = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const excelEpoch = Date.UTC(1899, 11, 30)
  return Math.round((utcMidnight - excelEpoch) / 86_400_000)
}

const MONTH_ABBR = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const

function abbreviateMonth(month: number): string {
  return MONTH_ABBR[month - 1] ?? "??"
}

/**
 * Build the PB ECP filename per the spec:
 *   `<10-digit account><PR><DDMMYY><NN>.xlsx`
 *   where NN starts at 01 and the same filename can't be re-uploaded
 *   in the same day unless the prior file was removed.
 *
 * Exposed for the service layer to use when persisting + downloading.
 */
export function buildPbEcpFileName(input: {
  payorAccountNo: string
  paymentDate: Date
  serial?: number
}): string {
  const acc = (input.payorAccountNo ?? "").replace(/[^0-9]/g, "").padStart(10, "0").slice(0, 10)
  const dd = String(input.paymentDate.getDate()).padStart(2, "0")
  const mm = String(input.paymentDate.getMonth() + 1).padStart(2, "0")
  const yy = String(input.paymentDate.getFullYear()).slice(-2)
  const serial = String(input.serial ?? 1).padStart(2, "0")
  return `${acc}PR${dd}${mm}${yy}${serial}.xlsx`
}
