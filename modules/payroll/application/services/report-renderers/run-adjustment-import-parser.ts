import "server-only"

import ExcelJS from "exceljs"

import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"

/**
 * Parses an uploaded bulk-adjustment XLSX for a payroll run into
 * structured rows. Structural validation only — matching employees to
 * profiles and applying the changes is the import service's job.
 *
 * Expected shape (first sheet, header row 1):
 *   | Full Name | Category | Label | Amount | Treat as recurring |
 *
 * `Treat as recurring` is optional — omit the column entirely if you
 * don't need it, or leave individual cells blank. Accepted values:
 * TRUE / FALSE / Y / N / 1 / 0 (case-insensitive). When set, the
 * flag flips PCB from the AR (one-off spike) formula to the recurring
 * (annualised, smooth) formula for that specific line — see
 * `ManualLineItem.treatAsRecurring` for the full explanation.
 *
 * Column matching is done by lowercased header text so admins can
 * safely reorder columns.
 *
 * The parser is intentionally strict: if ANY row is malformed, it
 * refuses the whole file (via `errors`), matching the product decision
 * that partial-import is confusing and hard to reverse.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type ParsedAdjustmentRow = {
  /// 1-indexed original row number, for error messages that point back
  /// at the admin's spreadsheet.
  rowNumber: number
  fullName: string
  /// The resolved enum code — one of `PAYROLL_ADJUSTMENT_CATEGORY_META`
  /// keys. Never the raw human label.
  category: PayrollAdjustmentCategory
  label: string
  amount: number
  /// LHDN Additional Remuneration override — see
  /// `ManualLineItem.treatAsRecurring`. `null` when the column is
  /// absent or the cell is blank (default = AR formula on AR-flagged
  /// categories). Only meaningful for AR-flagged categories
  /// (Gratuity, Director Fee, Commission, Bonus, Arrears, etc.) —
  /// ignored on non-AR categories.
  treatAsRecurring: boolean | null
}

/**
 * A per-employee basic-salary figure read from the optional
 * `Basic Salary` column. Emitted separately from the line-item `rows`
 * because salary is an attribute of the EMPLOYEE, not of any single
 * adjustment line. An employee may span several line-item rows; the
 * salary is read from whichever of their rows carries it (the template
 * pre-fills it on the first row only). The import service compares this
 * against the employee's current salary and, when it differs, records a
 * `SalaryChange` (increase or decrease) effective that run's period.
 */
export type ParsedAdjustmentSalary = {
  rowNumber: number
  fullName: string
  basicSalary: number
}

export type ParsedAdjustmentImport = {
  rows: ParsedAdjustmentRow[]
  /// Per-employee basic-salary values from the optional `Basic Salary`
  /// column. Empty when the column is absent or every cell is blank.
  salaries: ParsedAdjustmentSalary[]
  /// File-level errors — parser couldn't make sense of the sheet at
  /// all (missing required columns, empty sheet, unreadable workbook).
  errors: string[]
  /// Per-row errors. Non-empty means the caller must reject the whole
  /// file (product decision: no partial imports).
  rowErrors: Array<{ rowNumber: number; message: string }>
}

// ─── Lookup: human label → category code ────────────────────────────
// Case-insensitive, whitespace-collapsed. Populated once at module
// load from the meta table so a new category picks up its label
// automatically.

const CATEGORY_LABEL_TO_CODE = buildCategoryLookup()

function normaliseKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ")
}

function buildCategoryLookup(): Map<string, PayrollAdjustmentCategory> {
  const out = new Map<string, PayrollAdjustmentCategory>()
  for (const meta of Object.values(PAYROLL_ADJUSTMENT_CATEGORY_META)) {
    // Primary alias — the exact human label as shown in the dropdown.
    out.set(normaliseKey(meta.label), meta.code)
    // Secondary alias — the enum code itself, so power-users can paste
    // raw codes if they prefer.
    out.set(normaliseKey(meta.code), meta.code)
  }
  return out
}

/**
 * The full sorted list of accepted category labels — used by the
 * template renderer so the download shows the admin every allowed
 * value, and by error messages when a row uses an unknown category.
 */
export function listCategoryLabels(): string[] {
  return Object.values(PAYROLL_ADJUSTMENT_CATEGORY_META)
    .map((m) => m.label)
    .sort((a, b) => a.localeCompare(b))
}

// ─── Parser ─────────────────────────────────────────────────────────

export async function parseAdjustmentImport(
  buffer: ArrayBuffer,
): Promise<ParsedAdjustmentImport> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer)
  } catch {
    return {
      rows: [],
      salaries: [],
      errors: ["File is not a readable .xlsx workbook."],
      rowErrors: [],
    }
  }

  const sheet = wb.worksheets[0]
  if (!sheet) {
    return {
      rows: [],
      salaries: [],
      errors: ["The workbook has no sheets."],
      rowErrors: [],
    }
  }

  // Header row is row 1 — for a bulk-import file the admin builds
  // from the downloadable template, this is deterministic. (The YTD
  // parser scans for the header row because that template is much
  // more elaborate.)
  const headerRow = sheet.getRow(1)
  const columnByHeader = new Map<string, number>()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = normaliseKey(String(cell.value ?? ""))
    if (key.length > 0) columnByHeader.set(key, colNumber)
  })

  const nameCol = columnByHeader.get("full name")
  const categoryCol = columnByHeader.get("category")
  const labelCol = columnByHeader.get("label")
  const amountCol = columnByHeader.get("amount")
  // Optional — missing header is fine (behaves like the pre-column
  // template did). Accept a few variants so admins don't get stuck
  // on trivia.
  const treatCol =
    columnByHeader.get("treat as recurring") ??
    columnByHeader.get("treat_as_recurring") ??
    columnByHeader.get("treatasrecurring")
  // Optional — carries a per-employee monthly basic salary. When present
  // and different from the employee's current salary, the import records
  // a SalaryChange effective the run's period. Accept a few variants.
  const salaryCol =
    columnByHeader.get("basic salary") ??
    columnByHeader.get("basic_salary") ??
    columnByHeader.get("basicsalary") ??
    columnByHeader.get("monthly salary") ??
    columnByHeader.get("salary")

  const missing: string[] = []
  if (!nameCol) missing.push("Full Name")
  if (!categoryCol) missing.push("Category")
  if (!labelCol) missing.push("Label")
  if (!amountCol) missing.push("Amount")
  if (missing.length > 0) {
    return {
      rows: [],
      salaries: [],
      errors: [
        `Missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Download the template from the same dialog for the correct layout.`,
      ],
      rowErrors: [],
    }
  }

  const rows: ParsedAdjustmentRow[] = []
  const salaries: ParsedAdjustmentSalary[] = []
  const rowErrors: Array<{ rowNumber: number; message: string }> = []

  const lastRow = sheet.actualRowCount
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r)

    const rawName = cellText(row.getCell(nameCol!))
    const rawCategory = cellText(row.getCell(categoryCol!))
    const rawLabel = cellText(row.getCell(labelCol!))
    const rawAmount = cellNumeric(row.getCell(amountCol!))
    const rawTreat = treatCol ? cellBool(row.getCell(treatCol)) : null
    const rawSalary = salaryCol ? cellNumeric(row.getCell(salaryCol)) : null

    // A fully-blank row (no name, no line item, no salary) is a gap —
    // skip and keep scanning. The Basic Salary column means a row with
    // only a name + salary is NOT blank; it's a salary-only change.
    if (
      rawName.length === 0 &&
      rawCategory.length === 0 &&
      rawLabel.length === 0 &&
      rawAmount === null &&
      rawSalary === null
    ) {
      continue
    }

    // ── Basic Salary (optional, per employee) ─────────────────────────
    // Read wherever it appears on the employee's rows. Requires a name
    // and a positive value; the import service resolves the name and
    // dedupes multiple rows for the same employee.
    if (rawSalary !== null) {
      if (rawName.length === 0) {
        rowErrors.push({
          rowNumber: r,
          message: "Basic Salary needs a Full Name on the same row.",
        })
      } else if (rawSalary <= 0) {
        rowErrors.push({
          rowNumber: r,
          message: "Basic Salary must be a positive number.",
        })
      } else {
        salaries.push({
          rowNumber: r,
          fullName: rawName,
          // Round to 2dp — sheet floats can arrive as 5000.0000001.
          basicSalary: Math.round(rawSalary * 100) / 100,
        })
      }
    }

    // Rows carrying only a name (+ optional salary) but no line item are
    // intentional: either a salary-only change, or a pre-filled employee
    // the admin left untouched. Nothing more to do for the line-item path.
    if (
      rawCategory.length === 0 &&
      rawLabel.length === 0 &&
      rawAmount === null
    ) {
      continue
    }

    if (rawName.length === 0) {
      rowErrors.push({ rowNumber: r, message: "Full Name is required." })
      continue
    }
    if (rawCategory.length === 0) {
      rowErrors.push({ rowNumber: r, message: "Category is required." })
      continue
    }
    const category = CATEGORY_LABEL_TO_CODE.get(normaliseKey(rawCategory))
    if (!category) {
      rowErrors.push({
        rowNumber: r,
        message: `Unknown category "${rawCategory}". Download the template to see the accepted labels.`,
      })
      continue
    }
    if (rawLabel.length === 0) {
      rowErrors.push({ rowNumber: r, message: "Label is required." })
      continue
    }
    if (rawAmount === null || rawAmount <= 0) {
      rowErrors.push({
        rowNumber: r,
        message: "Amount must be a positive number.",
      })
      continue
    }

    rows.push({
      rowNumber: r,
      fullName: rawName,
      category,
      label: rawLabel,
      // Round to 2dp — sheet floats sometimes come through as 500.0000001
      // and we don't want to persist those.
      amount: Math.round(rawAmount * 100) / 100,
      treatAsRecurring: rawTreat,
    })
  }

  return { rows, salaries, errors: [], rowErrors }
}

// ─── Cell helpers ───────────────────────────────────────────────────

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value
  if (v == null) return ""
  if (typeof v === "string") return v.trim()
  if (typeof v === "number") return String(v).trim()
  if (typeof v === "boolean") return v ? "true" : "false"
  // Rich text / formula / hyperlink shapes
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) {
      return v.richText
        .map((rt) => (typeof rt.text === "string" ? rt.text : ""))
        .join("")
        .trim()
    }
    if ("result" in v && v.result != null) return String(v.result).trim()
    if ("text" in v && typeof v.text === "string") return v.text.trim()
  }
  return String(v).trim()
}

function cellNumeric(cell: ExcelJS.Cell): number | null {
  const v = cell.value
  if (v == null || v === "") return null
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    // Strip currency prefix + thousand separators so "RM 1,500.00" parses.
    const cleaned = v.replace(/[^0-9.\-]/g, "")
    if (cleaned.length === 0) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  if (typeof v === "object") {
    if ("result" in v && typeof v.result === "number") return v.result
  }
  return null
}

/**
 * Boolean cell reader that accepts the common truthy/falsy strings
 * admins actually type: TRUE/FALSE, Y/N, YES/NO, 1/0, T/F. Case-
 * insensitive. Returns `null` when the cell is blank OR the value
 * doesn't match a known shape (silently ignored rather than errored —
 * the column is optional so an unrecognised value degrades to "no
 * opinion" rather than blocking the whole import).
 */
function cellBool(cell: ExcelJS.Cell): boolean | null {
  const v = cell.value
  if (v == null || v === "") return null
  if (typeof v === "boolean") return v
  if (typeof v === "number") {
    if (v === 1) return true
    if (v === 0) return false
    return null
  }
  const s = String(v).trim().toLowerCase()
  if (s.length === 0) return null
  if (["true", "y", "yes", "t", "1", "✓", "✔"].includes(s)) return true
  if (["false", "n", "no", "f", "0", "-", "—"].includes(s)) return false
  return null
}
