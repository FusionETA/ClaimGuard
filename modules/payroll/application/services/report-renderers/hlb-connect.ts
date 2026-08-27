import "server-only"

import * as XLSX from "xlsx"

import { findBankByName } from "@/modules/payroll/domain/malaysian-banks"
import type { IdType } from "@/modules/payroll/domain/models"
import {
  getPayrollDisbursementRowsForOrg,
  type DisbursementRow,
} from "@/modules/payroll/application/services/payroll-run.service"

/**
 * Hong Leong Bank bulk-payroll renderers — one per upload channel:
 *
 *   • `renderHlbConnectFirstTxt`  → HLB Connect First (fixed-width TXT)
 *   • `renderHlbConnectBizXlsx`   → HLB ConnectBiz (CBIZ template XLSX)
 *
 * The ConnectBiz sheet reproduces HLB's own "CBIZ Bulk Payroll
 * Template" column-for-column (published at
 * hlb.com.my/Connect_Biz/templateDownload.htm). Note that a file
 * produced by another payroll vendor carried extra columns (Currency,
 * ID Validation, Transaction Type/Code, Purpose Of Transfer) and
 * compact ID codes like `NEWIC` — that is NOT this template, so don't
 * "correct" this layout to match one of those.
 *
 * Both describe the same payment, so the row-building logic is shared
 * and only the serialisation differs.
 *
 * ── Payment mode ────────────────────────────────────────────────────
 * Per the CBIZ Bulk Payroll template, HLB has three modes:
 *   FT  — intra-HLB transfer (bank code HLBB), any amount
 *   IBG — Interbank GIRO to any other bank, capped at RM 1,000,000
 *   RTS — RENTAS, minimum RM 10,000 (high-value; not used for payroll)
 *
 * Payroll therefore routes FT for Hong Leong accounts and IBG for
 * everyone else — the same split as Maybank's IT/IG and PB ECP's
 * PBB/IBG. A salary above the IBG ceiling is refused rather than
 * silently emitted, because the bank would reject the whole file.
 *
 * ── Bank codes ──────────────────────────────────────────────────────
 * HLB uses its own 4-character IBG codes (`MalaysianBank.hlbCode`),
 * NOT the BNM numeric codes. They are genuinely confusable: `PABB` is
 * AFFIN (from its old name Perwira Affin Bank) while Public Bank is
 * `PBBB`. The table is transcribed from the template's own
 * "Bank Code (IBG)" sheet — never infer one.
 *
 * ── Recipient Reference ─────────────────────────────────────────────
 * Mandatory on both channels and NOT derivable from payroll data (it's
 * what the employee sees on their bank statement), so the admin types
 * it per run in the downloads modal and it's threaded in here.
 */

/// IBG ceiling per the CBIZ template ("IBG: Max RM1Mil").
const IBG_MAX_AMOUNT = 1_000_000

/// Field widths for the Connect First fixed-width record (204 chars).
const W = {
  mode: 3,
  bankCode: 8,
  account: 20,
  name: 100,
  amount: 11,
  recipientRef: 20,
  otherDetails: 20,
  idType: 2,
  idValue: 20,
} as const

/// Max length the CBIZ template states for the Recipient Reference
/// column ("Max 20 characters").
const MAX_RECIPIENT_REF = 20

/**
 * Two-character ID type for the Connect First record. Only `NI` (New
 * IC) is corroborated by HLB's own sample output; the rest follow the
 * same convention Public Bank's ECP spec uses, since both are Malaysian
 * bulk-payment files sharing the NI/OI/BR/PL/ML/PP vocabulary.
 */
const TXT_ID_TYPE: Record<IdType, string> = {
  NRIC: "NI",
  PASSPORT: "PP",
  POLICE_NO: "PL",
  ARMY_NO: "ML",
}

/**
 * Spreadsheet equivalent. These are the literal dropdown labels in
 * HLB's own CBIZ Bulk Payroll template — "New IC No.", "Old IC No.",
 * "Business Registration No." and "Others" — not compact codes.
 * Verified against the unprotected v1.1 template published at
 * hlb.com.my/Connect_Biz/templateDownload.htm, whose sample rows use
 * "New IC No." verbatim.
 *
 * Anything that isn't an NRIC maps to "Others", which the template
 * documents as up to 20 alphanumeric characters — the only bucket that
 * accepts a passport or service number.
 */
const XLSX_ID_TYPE: Record<IdType, string> = {
  NRIC: "New IC No.",
  PASSPORT: "Others",
  POLICE_NO: "Others",
  ARMY_NO: "Others",
}

type HlbRow = {
  mode: "FT" | "IBG"
  bankCode: string
  account: string
  name: string
  amount: number
  idType: IdType | null
  idNumber: string
}

/** Printable-ASCII only, collapsed whitespace, clamped to `width`. */
function clean(value: string | null | undefined, width: number): string {
  return (value ?? "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, width)
}

function padRight(value: string, width: number): string {
  return clean(value, width).padEnd(width, " ")
}

/** Ringgit → sen, avoiding float drift on values like 1576.60. */
function toSen(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * Shared row builder: applies the skip rules, resolves each employee's
 * bank to an HLB code, and picks FT vs IBG. Throws on any condition the
 * bank would reject the file for, so the admin fixes the data rather
 * than discovering it at upload time.
 */
async function buildRows(input: {
  runId: string
  organizationId: string
  recipientReference?: string
}): Promise<{ rows: HlbRow[]; recipientReference: string }> {
  const recipientReference = clean(input.recipientReference, MAX_RECIPIENT_REF)
  if (recipientReference.length === 0) {
    throw new Error(
      "Recipient reference is required for the Hong Leong payroll file — enter one in the download panel. It appears on your employees' bank statements.",
    )
  }

  const data = await getPayrollDisbursementRowsForOrg({
    runId: input.runId,
    organizationId: input.organizationId,
  })
  if (!data) throw new Error("Payroll run not found.")

  const rows: HlbRow[] = []
  const unmatchedBanks: string[] = []
  const overLimit: string[] = []

  for (const row of data.rows as DisbursementRow[]) {
    const account = row.accountNumber.replace(/[^0-9]/g, "")
    if (account.length === 0) continue
    if (row.netAmount <= 0) continue

    const bank = findBankByName(row.bankName)
    if (!bank) {
      unmatchedBanks.push(`${row.employeeName} (${row.bankName})`)
      continue
    }

    // Intra-HLB credits go out as FT; everything else over IBG, which
    // the template caps at RM 1 million.
    const mode: "FT" | "IBG" = bank.hlbCode === "HLBB" ? "FT" : "IBG"
    if (mode === "IBG" && row.netAmount > IBG_MAX_AMOUNT) {
      overLimit.push(`${row.employeeName} (RM ${row.netAmount.toFixed(2)})`)
      continue
    }

    rows.push({
      mode,
      bankCode: bank.hlbCode,
      account,
      name: row.accountHolderName || row.employeeName,
      amount: row.netAmount,
      idType: row.idType,
      idNumber: (row.idNumber ?? "").trim(),
    })
  }

  if (unmatchedBanks.length > 0) {
    throw new Error(
      `Bank name not recognised for: ${unmatchedBanks.join(", ")}. Fix the bank name on each employee's payroll profile, then generate the file again.`,
    )
  }
  if (overLimit.length > 0) {
    throw new Error(
      `Hong Leong caps an IBG payment at RM 1,000,000 and these exceed it: ${overLimit.join(", ")}. Pay them separately via RENTAS.`,
    )
  }
  if (rows.length === 0) {
    throw new Error(
      "No payable rows in this run — every employee is missing a bank account number or has zero net pay.",
    )
  }

  return { rows, recipientReference }
}

// ─── Connect First (fixed-width TXT) ──────────────────────────────────

/**
 * 204-character records, CRLF-terminated, no header or trailer:
 *
 *   1-3     3  Payment mode (FT / IBG)
 *   4-11    8  Beneficiary bank code
 *   12-31  20  Beneficiary account no.
 *   32-131 100 Beneficiary name
 *   132-142 11 Amount in SEN (zero-padded, no decimal point)
 *   143-162 20 Recipient reference
 *   163-182 20 Other payment details
 *   183-184  2 Validation ID type
 *   185-204 20 Validation ID value
 */
export async function renderHlbConnectFirstTxt(input: {
  runId: string
  organizationId: string
  recipientReference?: string
}): Promise<Buffer> {
  const { rows, recipientReference } = await buildRows(input)

  const lines = rows.map((r) =>
    [
      padRight(r.mode, W.mode),
      padRight(r.bankCode, W.bankCode),
      padRight(r.account, W.account),
      padRight(r.name, W.name),
      String(toSen(r.amount)).padStart(W.amount, "0").slice(-W.amount),
      padRight(recipientReference, W.recipientRef),
      " ".repeat(W.otherDetails),
      padRight(r.idType ? TXT_ID_TYPE[r.idType] : "", W.idType),
      padRight(r.idNumber, W.idValue),
    ].join(""),
  )

  return Buffer.from(lines.join("\r\n") + "\r\n", "latin1")
}

// ─── ConnectBiz (CBIZ template spreadsheet) ───────────────────────────

/**
 * Header row, in the CBIZ Bulk Payroll template's exact column order
 * (v1.3 — v1.1 is identical minus the trailing e-mail column). The
 * asterisks mark the template's mandatory columns and are reproduced so
 * the sheet reads like the one HLB hands out.
 */
const CBIZ_HEADERS = [
  "*Payment Mode",
  "*Beneficiary Bank Code",
  "*Beneficiary Account No.",
  "*Beneficiary Name",
  "*Amount (RM)",
  "*Recipient Reference",
  "Other Payment Details",
  "Validation ID Type",
  "Validation ID Value",
  "Beneficiary E-mail Address",
] as const

export async function renderHlbConnectBizXlsx(input: {
  runId: string
  organizationId: string
  recipientReference?: string
}): Promise<Buffer> {
  const { rows, recipientReference } = await buildRows(input)

  const sheetRows: (string | number)[][] = [
    [...CBIZ_HEADERS],
    ...rows.map((r) => [
      r.mode,
      r.bankCode,
      r.account,
      // The template notes only the first 20 characters reach the
      // beneficiary's statement for FT/IBG; the full name is still sent.
      clean(r.name, 100),
      // Numeric, NOT text — the template's Amount column is a number and
      // a string would upload as an invalid amount.
      Number(r.amount.toFixed(2)),
      recipientReference,
      "",
      // ID validation applies to FT and IBG only, and only when we
      // actually hold an ID for the employee.
      r.idNumber && r.idType ? XLSX_ID_TYPE[r.idType] : "",
      r.idNumber,
      "",
    ]),
  ]

  const ws = XLSX.utils.aoa_to_sheet(sheetRows)
  // Account numbers and IDs are digit strings that Excel would otherwise
  // render in scientific notation; force them to text cells.
  for (let i = 0; i < rows.length; i++) {
    for (const col of ["C", "I"]) {
      const cell = ws[`${col}${i + 2}`]
      if (cell) cell.t = "s"
    }
  }
  ws["!cols"] = CBIZ_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 2) }))

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Data")
  return Buffer.from(
    XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer,
  )
}
