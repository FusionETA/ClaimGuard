import "server-only"

import ExcelJS from "exceljs"

/**
 * Reads a YTD import XLSX (the one our `ytd-import-template.ts`
 * renderer produces, with the admin's numbers filled in) and returns
 * a structured array of `(employee, month, amounts)` rows, plus
 * warnings/errors the import service can surface back to the admin.
 *
 * Robust by design:
 *   - Sheet is found by tab-name pattern, not position (admins may
 *     reorder tabs).
 *   - Columns are matched by HEADER TEXT, not column index, so a
 *     duplicated/removed optional column doesn't shift everything.
 *   - The header row is located by scanning for "Full Name" + "Personal
 *     ID" together — admins sometimes paste rows above and we don't
 *     want to lock onto a hardcoded row index.
 *   - Employee blocks are detected by a row that has a non-blank Name
 *     value AND a Personal ID value. The next 12 rows below are the
 *     month rows, regardless of what they're labelled.
 *
 * The parser only validates STRUCTURE. Business validation (does this
 * employee exist? does this month already have a submitted run?) is
 * the import service's job.
 */

// ─── Public types ───────────────────────────────────────────────────

export type ParsedYtdIdType = "NRIC" | "PASSPORT" | "OTHER"

export type ParsedYtdRow = {
  employeeName: string
  idType: ParsedYtdIdType
  idNumber: string
  /// Normalised for matching: digits-only for NRIC, alphanumeric-upper
  /// for passport. Use this when joining against profile.idNumber.
  idNumberNormalised: string
  /// 0..11 (January = 0)
  monthIdx: number
  amounts: {
    // Mandatory
    basicSalary: number
    pcb: number
    epfEmployee: number
    socsoEmployee: number
    eisEmployee: number
    epfEmployer: number
    socsoEmployer: number
    eisEmployer: number
    hrdf: number
    // Optional — populated when the column exists. Missing column ⇒ 0.
    bonus: number
    commission: number
    overtime: number
    serviceCharge: number
    travelAllowance: number
    parkingAllowance: number
    phoneAllowance: number
    otherAllowance: number
    unpaidLeave: number
    netSalaryDeduction: number
    zakat: number
  }
}

export type ParsedYtdImport = {
  rows: ParsedYtdRow[]
  /// Non-fatal — admin can still proceed with the importable rows.
  warnings: string[]
  /// Fatal at the file level — parser couldn't make sense of the
  /// workbook (wrong tab, missing mandatory columns, etc.) and the
  /// import service should refuse to write anything.
  errors: string[]
}

// ─── Column header text → key on amounts ────────────────────────────
// Lowercased + whitespace-collapsed for case-insensitive matching.

const MANDATORY_HEADER_TO_KEY = {
  "basic salary": "basicSalary",
  pcb: "pcb",
  "employee epf": "epfEmployee",
  "employee socso": "socsoEmployee",
  "employee eis": "eisEmployee",
  "employer epf": "epfEmployer",
  "employer socso": "socsoEmployer",
  "employer eis": "eisEmployer",
  hrdf: "hrdf",
} as const

const OPTIONAL_HEADER_TO_KEY: Record<string, keyof ParsedYtdRow["amounts"]> = {
  bonus: "bonus",
  commission: "commission",
  overtime: "overtime",
  "service charge": "serviceCharge",
  "travel/petrol allowance": "travelAllowance",
  "travel allowance": "travelAllowance",
  "petrol allowance": "travelAllowance",
  "parking allowance": "parkingAllowance",
  "phone/broadband allowance": "phoneAllowance",
  "phone allowance": "phoneAllowance",
  "broadband allowance": "phoneAllowance",
  "other allowance": "otherAllowance",
  "unpaid leave": "unpaidLeave",
  "net salary deduction": "netSalaryDeduction",
  zakat: "zakat",
}

// Display labels for the unknown-column warning. Keyed on the same
// amount-key the OPTIONAL_HEADER_TO_KEY maps to, so we don't list
// every alias (e.g. travelAllowance has three header aliases — admin
// only needs to know one canonical name to use).
const OPTIONAL_KEY_LABEL: Partial<Record<keyof ParsedYtdRow["amounts"], string>> = {
  bonus: "Bonus",
  commission: "Commission",
  overtime: "Overtime",
  serviceCharge: "Service Charge",
  travelAllowance: "Travel/Petrol Allowance",
  parkingAllowance: "Parking Allowance",
  phoneAllowance: "Phone/Broadband Allowance",
  otherAllowance: "Other Allowance",
  unpaidLeave: "Unpaid Leave",
  netSalaryDeduction: "Net Salary Deduction",
  zakat: "Zakat",
}

const NAME_HEADER = "full name"
const ID_HEADER = "personal id"

// ─── Entry point ────────────────────────────────────────────────────

export async function parseYtdImport(
  buffer: Buffer,
): Promise<ParsedYtdImport> {
  const out: ParsedYtdImport = { rows: [], warnings: [], errors: [] }

  let wb: ExcelJS.Workbook
  try {
    wb = new ExcelJS.Workbook()
    // exceljs's typings want a plain ArrayBuffer (not a Node Buffer /
    // Uint8Array view). Slice the underlying buffer at the right
    // byte-range to hand it the exact bytes the Buffer is wrapping.
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer
    await wb.xlsx.load(ab)
  } catch (err) {
    out.errors.push(
      `Couldn't open file as an XLSX workbook: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return out
  }

  // Find the data sheet (✏️ prefix) — fall back to the first sheet
  // that isn't Instructions (📕) or Sample (📗).
  const editSheet = findEditSheet(wb)
  if (!editSheet) {
    out.errors.push(
      "Couldn't find the YTD data sheet. Expected a tab starting with ✏️.",
    )
    return out
  }

  // Locate the header row + map column index → amount key.
  const header = findHeaderRow(editSheet)
  if (!header) {
    out.errors.push(
      'Couldn\'t find the header row. Expected "Full Name" and "Personal ID" on the same row.',
    )
    return out
  }

  // Check every mandatory column is present.
  const missingMandatory: string[] = []
  const mandatoryKeys = Object.values(MANDATORY_HEADER_TO_KEY)
  for (const [headerText, key] of Object.entries(MANDATORY_HEADER_TO_KEY)) {
    if (!header.colByKey.has(key)) {
      missingMandatory.push(toTitleCase(headerText))
    }
  }
  if (missingMandatory.length > 0) {
    out.errors.push(
      `Missing mandatory column${missingMandatory.length === 1 ? "" : "s"}: ${missingMandatory.join(", ")}. Don't rename or delete the mandatory headers.`,
    )
    return out
  }

  // Flag unknown columns so admins who renamed or invented headers
  // (e.g. "Annual Bonus", "Director Fee", "Medical Allowance") see
  // WHY their values didn't land. Column names are a fixed allowlist
  // — only the listed names are read. For anything that doesn't fit,
  // admin should use "Other Allowance" (which catches all into the
  // imported payslip's totalAllowances bucket).
  if (header.unknownHeaders.length > 0) {
    const supportedOptionals = Array.from(
      new Set(Object.values(OPTIONAL_HEADER_TO_KEY)),
    )
      .map((key) => OPTIONAL_KEY_LABEL[key])
      .filter(Boolean)
      .join(", ")
    out.warnings.push(
      `Ignored ${header.unknownHeaders.length} unrecognised column header${
        header.unknownHeaders.length === 1 ? "" : "s"
      }: ${header.unknownHeaders.map((h) => `"${h}"`).join(", ")}. ` +
        `Only fixed names are read; rename to one of: ${supportedOptionals}, or use "Other Allowance" for anything else.`,
    )
  }

  // Walk rows after the header row, finding employee blocks.
  for (
    let r = header.rowNum + 1;
    r <= editSheet.actualRowCount + 1 && r <= editSheet.rowCount + 50;
    r++
  ) {
    const nameCell = editSheet.getCell(r, header.nameCol).value
    const idCell = editSheet.getCell(r, header.idCol).value
    const nameStr = cellToString(nameCell).trim()
    const idStr = cellToString(idCell).trim()
    if (!nameStr || !idStr) continue
    // Skip rows that look like month labels (defensive — header row
    // anchor should prevent this from triggering).
    if (isMonthName(nameStr)) continue

    const parsedId = parsePersonalId(idStr)
    if (!parsedId) {
      out.warnings.push(
        `Row ${r}: couldn't parse Personal ID "${idStr}" for "${nameStr}" — expected "NRIC: 001127-08-0576" or "Passport: A1234567". Skipped.`,
      )
      // Still advance past the 12 month rows of this block so the
      // next employee isn't read as part of it.
      r += 12
      continue
    }

    // Walk the next 12 rows as January..December.
    for (let m = 0; m < 12; m++) {
      const monthRow = r + 1 + m
      if (monthRow > editSheet.rowCount + 100) break

      // Read every mandatory + optional column for this month.
      const amounts: ParsedYtdRow["amounts"] = freshAmounts()
      let hasAny = false
      for (const [key, colNum] of header.colByKey.entries()) {
        if (!isAmountKey(key)) continue
        const raw = editSheet.getCell(monthRow, colNum).value
        const n = cellToNumber(raw)
        if (n !== 0) hasAny = true
        ;(amounts as Record<string, number>)[key] = n
      }
      // Skip month rows where everything is zero or blank — that month
      // either wasn't paid (employee not yet on payroll) or the admin
      // hasn't filled it. Either way, nothing to import.
      if (!hasAny) continue

      out.rows.push({
        employeeName: nameStr,
        idType: parsedId.idType,
        idNumber: parsedId.idNumber,
        idNumberNormalised: normaliseIdNumber(parsedId.idType, parsedId.idNumber),
        monthIdx: m,
        amounts,
      })
    }

    // Advance the outer loop past the 12 month rows of this block. The
    // for-loop's `r++` will then move us to the next employee's
    // header row.
    r += 12
  }

  if (out.rows.length === 0 && out.warnings.length === 0) {
    out.warnings.push(
      "No month rows had any values. Make sure you filled the month rows below each employee's header row.",
    )
  }

  void mandatoryKeys // (silences unused-binding when minified)
  return out
}

// ─── Sheet + header detection ───────────────────────────────────────

function findEditSheet(wb: ExcelJS.Workbook): ExcelJS.Worksheet | null {
  // Priority 1: tab name starts with the edit-me pencil emoji.
  for (const ws of wb.worksheets) {
    if (ws.name.trim().startsWith("✏️")) return ws
  }
  // Priority 2: first sheet that isn't Instructions / Sample.
  for (const ws of wb.worksheets) {
    const n = ws.name.trim()
    if (n.startsWith("📕") || n.startsWith("📗")) continue
    return ws
  }
  return null
}

type HeaderMap = {
  rowNum: number
  nameCol: number
  idCol: number
  /// Maps amount-key (e.g. "basicSalary") → column number.
  colByKey: Map<string, number>
  /// Header cells that don't match Full Name / Personal ID, any
  /// mandatory column, or any optional column. Surfaced as a parser
  /// warning so admins who renamed or invented columns (e.g. "Annual
  /// Bonus" instead of "Bonus", or "Director Fee") see explicitly
  /// what got silently dropped + the supported list of column names.
  unknownHeaders: string[]
}

function findHeaderRow(ws: ExcelJS.Worksheet): HeaderMap | null {
  // Scan the first 20 rows for a row that contains both NAME_HEADER
  // and ID_HEADER.
  const maxScan = Math.min(20, ws.rowCount)
  for (let r = 1; r <= maxScan; r++) {
    const row = ws.getRow(r)
    let nameCol = 0
    let idCol = 0
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = cellToString(row.getCell(c).value).toLowerCase().trim()
      if (v === NAME_HEADER) nameCol = c
      else if (v === ID_HEADER) idCol = c
    }
    if (nameCol === 0 || idCol === 0) continue

    // Found it — map every other header on this row.
    const colByKey = new Map<string, number>()
    const unknownHeaders: string[] = []
    for (let c = 1; c <= ws.columnCount; c++) {
      const rawCell = cellToString(row.getCell(c).value).trim()
      if (!rawCell) continue
      const text = rawCell.toLowerCase()
      if (text === NAME_HEADER || text === ID_HEADER) continue
      const mandatoryKey =
        (MANDATORY_HEADER_TO_KEY as Record<string, string>)[text]
      if (mandatoryKey) {
        colByKey.set(mandatoryKey, c)
        continue
      }
      const optionalKey = OPTIONAL_HEADER_TO_KEY[text]
      if (optionalKey) {
        colByKey.set(optionalKey, c)
        continue
      }
      // Capture the ORIGINAL casing so the warning reads naturally
      // ("Annual Bonus" not "annual bonus").
      unknownHeaders.push(rawCell)
    }
    return { rowNum: r, nameCol, idCol, colByKey, unknownHeaders }
  }
  return null
}

// ─── Cell coercion ──────────────────────────────────────────────────

function cellToString(v: ExcelJS.CellValue): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (v instanceof Date) return v.toISOString()
  // ExcelJS rich-text / formula objects
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) {
      return v.richText.map((r) => r.text).join("")
    }
    if ("text" in v && typeof v.text === "string") return v.text
    if ("result" in v && v.result != null) return cellToString(v.result)
  }
  return String(v)
}

function cellToNumber(v: ExcelJS.CellValue): number {
  if (v == null || v === "") return 0
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  if (typeof v === "boolean") return v ? 1 : 0
  if (v instanceof Date) return 0
  if (typeof v === "object") {
    if ("result" in v && v.result != null) return cellToNumber(v.result)
    if ("text" in v && typeof v.text === "string") return parseLooseNumber(v.text)
  }
  if (typeof v === "string") return parseLooseNumber(v)
  return 0
}

function parseLooseNumber(s: string): number {
  // Strip currency / thousands separators, accept negatives with
  // parens. Reject anything else as 0.
  const cleaned = s.replace(/[,\sRMrm$]/g, "").trim()
  if (!cleaned) return 0
  const inParens = /^\((.*)\)$/.exec(cleaned)
  const text = inParens ? `-${inParens[1]}` : cleaned
  const n = Number(text)
  return Number.isFinite(n) ? n : 0
}

// ─── Personal ID parsing ────────────────────────────────────────────

function parsePersonalId(raw: string): {
  idType: ParsedYtdIdType
  idNumber: string
} | null {
  const trimmed = raw.trim()
  // "NRIC: xxx" / "Passport: xxx" / "Other: xxx"
  const m = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(trimmed)
  if (m) {
    const label = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    if (!value) return null
    if (label === "nric" || label === "ic" || label === "mykad") {
      return { idType: "NRIC", idNumber: value }
    }
    if (label === "passport" || label === "passportno" || label === "pp") {
      return { idType: "PASSPORT", idNumber: value }
    }
    return { idType: "OTHER", idNumber: value }
  }
  // No prefix — infer.
  if (/^\d{6}-?\d{2}-?\d{4}$/.test(trimmed.replace(/\s/g, ""))) {
    return { idType: "NRIC", idNumber: trimmed }
  }
  return { idType: "PASSPORT", idNumber: trimmed }
}

function normaliseIdNumber(
  idType: ParsedYtdIdType,
  idNumber: string,
): string {
  switch (idType) {
    case "NRIC":
      return idNumber.replace(/\D/g, "")
    case "PASSPORT":
      return idNumber.replace(/\s/g, "").toUpperCase()
    case "OTHER":
      return idNumber.replace(/\s/g, "").toUpperCase()
  }
}

// ─── Misc helpers ───────────────────────────────────────────────────

function freshAmounts(): ParsedYtdRow["amounts"] {
  return {
    basicSalary: 0,
    pcb: 0,
    epfEmployee: 0,
    socsoEmployee: 0,
    eisEmployee: 0,
    epfEmployer: 0,
    socsoEmployer: 0,
    eisEmployer: 0,
    hrdf: 0,
    bonus: 0,
    commission: 0,
    overtime: 0,
    serviceCharge: 0,
    travelAllowance: 0,
    parkingAllowance: 0,
    phoneAllowance: 0,
    otherAllowance: 0,
    unpaidLeave: 0,
    netSalaryDeduction: 0,
    zakat: 0,
  }
}

function isAmountKey(key: string): key is keyof ParsedYtdRow["amounts"] {
  return key in freshAmounts()
}

const MONTH_NAMES = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
])

function isMonthName(s: string): boolean {
  return MONTH_NAMES.has(s.toLowerCase().trim())
}

function toTitleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ")
}
