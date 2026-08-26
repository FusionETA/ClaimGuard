import "server-only"

import { findBankByName } from "@/modules/payroll/domain/malaysian-banks"
import type { IdType } from "@/modules/payroll/domain/models"
import { getPayrollDisbursementRowsForOrg } from "@/modules/payroll/application/services/payroll-run.service"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"

/**
 * BizChannel@CIMB bulk-payroll file renderer.
 *
 * Produces the fixed-width TXT that CIMB's BizConverter emits for the
 * "Bulk Payments (Without Email)" module, for upload at BizChannel@CIMB
 * → Bulk Payments → Payroll (File Format: TXT, File Type: Non
 * Encrypted).
 *
 * Three record types, CRLF-terminated:
 *
 *   01 — header : org code + company name + payment date
 *   02 — detail : one per employee
 *   03 — trailer: record count + total amount
 *
 * ── Field layout ────────────────────────────────────────────────────
 * Header (73 chars)
 *   1-2    2   Record type "01"
 *   3-7    5   Autopay Organisation Code (issued by CIMB)
 *   8-47  40   Company name
 *   48-55  8   Payment date DDMMYYYY
 *   56-71 16   Zero-filled (see UNVERIFIED below)
 *   72-73  2   Blank
 *
 * Detail (127 chars)
 *   1-2     2  Record type "02"
 *   3-4     2  BNM bank code
 *   5-20   16  Beneficiary account number
 *   21-25   5  Blank (see UNVERIFIED below)
 *   26-65  40  Beneficiary name
 *   66-76  11  Payment amount in SEN (no decimal point)
 *   77-106 30  Reference number
 *   107-126 20 Beneficiary ID (NRIC / passport)
 *   127     1  ID type (see UNVERIFIED below)
 *
 * Trailer (21 chars)
 *   1-2    2   Record type "03"
 *   3-8    6   Record count
 *   9-21  13   Total amount in SEN
 *
 * ── UNVERIFIED ──────────────────────────────────────────────────────
 * The layout above was reverse-engineered from a BizConverter-produced
 * sample plus the BizConverter Excel template's column widths, because
 * CIMB's published guide covers only the upload UI, not the file spec.
 * Three positions could not be pinned down from a single sample and
 * are emitted exactly as the sample had them:
 *
 *   • Header 56-71  — sixteen '0's in the sample.
 *   • Detail 21-25  — blank in the sample.
 *   • Detail 127    — '2' for all three sample rows, every one of which
 *     had a New NRIC. Modelled here as an ID-type code following the
 *     usual Malaysian convention (1 = old IC, 2 = new IC, 3 = passport,
 *     4 = other). Only '2' is corroborated by the sample.
 *
 * Verify against a real BizChannel upload before trusting this in
 * production, and re-check `ID_TYPE_CODES` if any non-NRIC employee is
 * ever included in a run.
 */

const HEADER_ORG_CODE = 5
const HEADER_COMPANY_NAME = 40
const DETAIL_ACCOUNT = 16
const DETAIL_GAP = 5
const DETAIL_NAME = 40
const DETAIL_AMOUNT = 11
const DETAIL_REFERENCE = 30
const DETAIL_BENE_ID = 20
const TRAILER_COUNT = 6
const TRAILER_TOTAL = 13

/**
 * Detail position 127. See UNVERIFIED in the file header — only the
 * NRIC value is corroborated by CIMB's own sample output.
 */
const ID_TYPE_CODES: Record<IdType, string> = {
  NRIC: "2",
  PASSPORT: "3",
  POLICE_NO: "4",
  ARMY_NO: "4",
}
const DEFAULT_ID_TYPE_CODE = "2"

/**
 * Plain fixed-width text. Anything outside printable ASCII is dropped —
 * the converter is a Windows/latin1 tool and non-ASCII round-trips
 * badly. Used for the columns the template types as plain "Char":
 * company name and payment description.
 */
function text(value: string | null | undefined, width: number): string {
  const cleaned = (value ?? "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, width)
  return cleaned.padEnd(width, " ")
}

/**
 * Variant for the three columns the template types as "Char without
 * '-' or '/'" — Beneficiary Name, Beneficiary ID and Reference Number.
 * Those separators are replaced with a space rather than passed
 * through. Note the company-name column carries no such restriction
 * (CIMB's own sample output contains a hyphen), so it uses `text`.
 */
function textNoSeparators(
  value: string | null | undefined,
  width: number,
): string {
  return text((value ?? "").replace(/[-/]/g, " "), width)
}

/** Digits only, left-aligned then space-padded (matches the sample). */
function digitsPadded(
  value: string | null | undefined,
  width: number,
): string {
  return (value ?? "")
    .replace(/[^0-9]/g, "")
    .slice(0, width)
    .padEnd(width, " ")
}

/** Zero-padded integer, right-aligned — used for counts and amounts. */
function zeroPad(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, "0").slice(-width)
}

/** Ringgit → sen, avoiding float drift on values like 1576.60. */
function toSen(amount: number): number {
  return Math.round(amount * 100)
}

function formatDdmmyyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  return `${dd}${mm}${date.getFullYear()}`
}

export async function renderCimbBizChannelTxt(input: {
  runId: string
  /// Already-authorised org that owns the run (threaded from
  /// `renderPayrollReport`).
  organizationId: string
  /// Payment date written into the header. Defaults to the last day of
  /// the run's period month.
  paymentDate?: Date
}): Promise<Buffer> {
  const orgId = input.organizationId

  const [settings, data] = await Promise.all([
    payrollSettingsRepository.getByOrgId(orgId),
    getPayrollDisbursementRowsForOrg({ runId: input.runId, organizationId: orgId }),
  ])

  if (!data) throw new Error("Payroll run not found.")

  // "Autopay Organisation Code" in CIMB's template — issued by their
  // Business Call Centre when bulk payroll is enabled. Stored in the
  // bank-agnostic `payorOrganisationCode` setting.
  const orgCode = (settings?.payorOrganisationCode ?? "").replace(
    /[^0-9]/g,
    "",
  )
  if (orgCode.length === 0) {
    throw new Error(
      "CIMB Organisation Code is not configured. Set it under Payroll Settings → Bank → Organisation code before generating the CIMB file.",
    )
  }
  if (orgCode.length > HEADER_ORG_CODE) {
    throw new Error(
      `CIMB Organisation Code must be at most ${HEADER_ORG_CODE} digits (currently ${orgCode.length}). Update it under Payroll Settings → Bank.`,
    )
  }

  const { run, organizationName } = data
  const paymentDate =
    input.paymentDate ?? new Date(run.periodYear, run.periodMonth, 0)

  const lines: string[] = [
    [
      "01",
      orgCode.padEnd(HEADER_ORG_CODE, " "),
      text(organizationName, HEADER_COMPANY_NAME),
      formatDdmmyyyy(paymentDate),
      "0".repeat(16),
      "  ",
    ].join(""),
  ]

  const unmatchedBanks: string[] = []
  let totalSen = 0
  let count = 0

  for (const row of data.rows) {
    // Same skip rules as the other bank files — nothing to pay, or no
    // account for the bank to credit.
    const account = row.accountNumber.replace(/[^0-9]/g, "")
    if (account.length === 0) continue
    if (row.netAmount <= 0) continue

    const bank = findBankByName(row.bankName)
    if (!bank) {
      unmatchedBanks.push(`${row.employeeName} (${row.bankName})`)
      continue
    }

    const sen = toSen(row.netAmount)
    totalSen += sen
    count += 1

    const idNumber = (row.idNumber ?? "").trim()
    const idTypeCode = idNumber
      ? row.idType
        ? ID_TYPE_CODES[row.idType]
        : DEFAULT_ID_TYPE_CODE
      : " "

    lines.push(
      [
        "02",
        bank.bnmCode,
        digitsPadded(account, DETAIL_ACCOUNT),
        " ".repeat(DETAIL_GAP),
        textNoSeparators(row.accountHolderName || row.employeeName, DETAIL_NAME),
        zeroPad(sen, DETAIL_AMOUNT),
        textNoSeparators(row.reference, DETAIL_REFERENCE),
        // NRIC goes in digits-only; a passport keeps its letters.
        row.idType === "NRIC"
          ? digitsPadded(idNumber, DETAIL_BENE_ID)
          : textNoSeparators(idNumber, DETAIL_BENE_ID),
        idTypeCode,
      ].join(""),
    )
  }

  if (count === 0) {
    throw new Error(
      unmatchedBanks.length > 0
        ? `No payable rows — none of the employees' banks could be matched: ${unmatchedBanks.join(", ")}.`
        : "No payable rows in this run — every employee is missing a bank account number or has zero net pay.",
    )
  }

  if (unmatchedBanks.length > 0) {
    throw new Error(
      `Bank name not recognised for: ${unmatchedBanks.join(", ")}. Fix the bank name on each employee's payroll profile, then generate the file again.`,
    )
  }

  lines.push(
    ["03", zeroPad(count, TRAILER_COUNT), zeroPad(totalSen, TRAILER_TOTAL)].join(
      "",
    ),
  )

  // CRLF with a trailing newline — matches BizConverter's own output.
  return Buffer.from(lines.join("\r\n") + "\r\n", "latin1")
}
