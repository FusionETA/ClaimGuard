import "server-only"

import {
  findBankByName,
  isMaybankName,
} from "@/modules/payroll/domain/malaysian-banks"
import type { IdType } from "@/modules/payroll/domain/models"
import { getPayrollDisbursementRowsForOrg } from "@/modules/payroll/application/services/payroll-run.service"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"

/**
 * Maybank2E-RC Universal Payment File renderer (spec v4.3).
 *
 * Produces the pipe-delimited TXT accepted by Maybank2E → Bulk Payment
 * upload. Structure is three record types, one per line:
 *
 *   00|<header>     — 29 fields  (Corporate ID + Client Batch ID)
 *   01|<record>     — 337 fields (one per employee)
 *   99|<trailer>    — 29 fields  (total count + total debiting amount)
 *
 * Every field position is emitted even when blank (the spec numbers
 * fillers 148–336 as real fields), because Maybank's parser is
 * positional: trailing empties are harmless, missing ones shift every
 * later value into the wrong column.
 *
 * Payroll uses Provider Product Group "Staff Payroll" (the MY entry in
 * Appendix Table 2), with the payment mode chosen per employee:
 *   • IT — Book Transfer Third Party, when the employee also banks
 *     with Maybank (intra-bank, no bene bank code).
 *   • IG — Outward ACH (IBG), for every other Malaysian bank; requires
 *     the beneficiary's bank BIC in field 37.
 *
 * This mirrors the PB ECP renderer's PBB/IBG split.
 */

/// Total field counts per record type, straight from the spec tables.
const HEADER_FIELDS = 29
const RECORD_FIELDS = 337
const FOOTER_FIELDS = 29

/// Provider Product Group Name for Malaysian staff payroll
/// (Appendix Table 2, row 30 — modes IA, IT, IG, IM).
const PRODUCT_GROUP = "Staff Payroll"

const CURRENCY = "MYR"

/**
 * Characters Maybank accepts (General Information, page 3). The pipe
 * is listed as supported but is also the delimiter, so it is stripped
 * here — leaving one in a value would silently split the record.
 */
const SUPPORTED = /[^0-9A-Za-z !"#$%&'()*+,\-./{}~:;<=>?@[\]^_`\\ ]/g

/**
 * Sanitise a value for a delimited field: drop unsupported characters,
 * remove the delimiter, collapse whitespace and clamp to the field's
 * maximum length.
 */
function field(value: string | null | undefined, maxLength: number): string {
  if (!value) return ""
  return value
    .replace(/\|/g, " ")
    .replace(SUPPORTED, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

/** Digits-only variant for numeric fields (account numbers, IDs). */
function digits(value: string | null | undefined, maxLength: number): string {
  if (!value) return ""
  return value.replace(/[^0-9]/g, "").slice(0, maxLength)
}

/** DDMMYYYY — the spec's date format for Value Date. */
function formatDdmmyyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  return `${dd}${mm}${date.getFullYear()}`
}

/**
 * Build one delimited line from a sparse map of 1-based field number →
 * value. Positions not supplied are emitted as empty fields.
 */
function line(total: number, values: Record<number, string>): string {
  const cells = new Array<string>(total).fill("")
  for (const [pos, value] of Object.entries(values)) {
    cells[Number(pos) - 1] = value
  }
  return cells.join("|")
}

/**
 * Map our `IdType` onto the Maybank record's four separate ID columns
 * (fields 25–28). Unlike PB ECP — which has one "type + number" pair —
 * Maybank wants the number written into the column matching its kind,
 * with the others blank.
 */
function mapIdFields(
  idType: IdType | null,
  idNumber: string | null,
): { newIdNo: string; oldIdNo: string; businessRegNo: string; passportNo: string } {
  const blank = { newIdNo: "", oldIdNo: "", businessRegNo: "", passportNo: "" }
  const raw = (idNumber ?? "").trim()
  if (raw.length === 0) return blank

  switch (idType) {
    case "NRIC":
      return { ...blank, newIdNo: digits(raw, 20) }
    case "PASSPORT":
    case "POLICE_NO":
    case "ARMY_NO":
      // Maybank has no dedicated police/army column on the payment
      // record — the spec groups them with passport in field 28.
      return { ...blank, passportNo: field(raw, 20) }
    default:
      // Unknown type: treat a purely numeric value as an NRIC,
      // otherwise fall back to the passport column.
      return /^\d+$/.test(raw.replace(/[^0-9A-Za-z]/g, ""))
        ? { ...blank, newIdNo: digits(raw, 20) }
        : { ...blank, passportNo: field(raw, 20) }
  }
}

export async function renderMbbM2eTxt(input: {
  runId: string
  /// Already-authorised org that owns the run (threaded from
  /// `renderPayrollReport`).
  organizationId: string
  /// Value date for the payment. Defaults to the last day of the run's
  /// period month. Maybank accepts up to 90 days future-dated.
  paymentDate?: Date
}): Promise<Buffer> {
  const orgId = input.organizationId

  const [settings, data] = await Promise.all([
    payrollSettingsRepository.getByOrgId(orgId),
    getPayrollDisbursementRowsForOrg({ runId: input.runId, organizationId: orgId }),
  ])

  if (!data) throw new Error("Payroll run not found.")

  // Corporate ID is issued by Maybank when the M2E service is set up;
  // we reuse the bank-agnostic `payorOrganisationCode` setting for it.
  const corporateId = field(settings?.payorOrganisationCode, 30)
  if (corporateId.length === 0) {
    throw new Error(
      "Maybank Corporate ID is not configured. Set it under Payroll Settings → Bank → Organisation code before generating the Maybank file.",
    )
  }

  const debitAccount = digits(settings?.ecpPayorAccountNo, 20)
  if (debitAccount.length === 0) {
    throw new Error(
      "Maybank debiting account number is not configured. Set it under Payroll Settings → Bank before generating the Maybank file.",
    )
  }

  const { run } = data
  const valueDate =
    input.paymentDate ?? new Date(run.periodYear, run.periodMonth, 0)
  const valueDateStr = formatDdmmyyyy(valueDate)
  const periodTag = `${run.periodYear}${String(run.periodMonth).padStart(2, "0")}`

  // Client Batch ID must be unique per submission for the client's own
  // reconciliation — org code + period keeps it stable and readable.
  const clientBatchId = field(`PR${periodTag}${corporateId}`, 30)

  const lines: string[] = [
    line(HEADER_FIELDS, {
      1: "00",
      2: corporateId,
      3: clientBatchId,
    }),
  ]

  const unmatchedBanks: string[] = []
  let totalAmount = 0
  let count = 0

  for (const row of data.rows) {
    // Same skip rules as the PB ECP file — the bank can't act on a row
    // with no account number or nothing to pay.
    const account = digits(row.accountNumber, 35)
    if (account.length === 0) continue
    if (row.netAmount <= 0) continue

    const bank = findBankByName(row.bankName)
    if (!bank) {
      unmatchedBanks.push(`${row.employeeName} (${row.bankName})`)
      continue
    }

    // Intra-Maybank credits are a book transfer (IT) and must leave the
    // bene bank code blank; everything else goes out over ACH/IBG (IG)
    // and carries the beneficiary bank's BIC.
    const intraMaybank = isMaybankName(row.bankName)
    const paymentMode = intraMaybank ? "IT" : "IG"
    const beneBankCode = intraMaybank ? "" : field(bank.bic, 11)

    const ids = mapIdFields(row.idType, row.idNumber)
    count += 1
    totalAmount += row.netAmount

    lines.push(
      line(RECORD_FIELDS, {
        1: "01",
        2: paymentMode,
        3: PRODUCT_GROUP,
        5: valueDateStr,
        // Must be unique within the file — sequence guarantees that
        // even when two employees share an employee code.
        8: field(`${periodTag}${String(row.sequence).padStart(4, "0")}`, 30),
        9: field(row.reference, 55),
        10: field(`Salary ${periodTag}`, 55),
        11: CURRENCY,
        12: row.netAmount.toFixed(2),
        // Debit and transaction currency are both MYR, so the amount is
        // already in the debit account's currency.
        13: "Y",
        14: CURRENCY,
        15: debitAccount,
        16: account,
        19: row.isResident ? "Y" : "N",
        20: field(row.accountHolderName || row.employeeName, 40),
        25: ids.newIdNo,
        26: ids.oldIdNo,
        27: ids.businessRegNo,
        28: ids.passportNo,
        37: beneBankCode,
      }),
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
    line(FOOTER_FIELDS, {
      1: "99",
      2: String(count),
      3: totalAmount.toFixed(2),
      // Field 4 (Hashing Value) is conditional — the formula is issued
      // by Maybank per corporate. Left blank until a customer needs it.
    }),
  )

  // CRLF terminators, with a trailing newline — matches the sample
  // files Maybank's own converter emits.
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf8")
}

/**
 * Maybank doesn't mandate a filename pattern for M2E uploads (unlike PB
 * ECP), so we use a readable, collision-free one.
 */
export function buildMbbM2eFileName(run: {
  periodYear: number
  periodMonth: number
}): string {
  const mm = String(run.periodMonth).padStart(2, "0")
  return `MBB_M2E_Payroll_${mm}${run.periodYear}.txt`
}
