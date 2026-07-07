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
 *   | Full Name | Category | Label | Amount |
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
}

export type ParsedAdjustmentImport = {
  rows: ParsedAdjustmentRow[]
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
      errors: ["File is not a readable .xlsx workbook."],
      rowErrors: [],
    }
  }

  const sheet = wb.worksheets[0]
  if (!sheet) {
    return {
      rows: [],
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

  const missing: string[] = []
  if (!nameCol) missing.push("Full Name")
  if (!categoryCol) missing.push("Category")
  if (!labelCol) missing.push("Label")
  if (!amountCol) missing.push("Amount")
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        `Missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Download the template from the same dialog for the correct layout.`,
      ],
      rowErrors: [],
    }
  }

  const rows: ParsedAdjustmentRow[] = []
  const rowErrors: Array<{ rowNumber: number; message: string }> = []

  const lastRow = sheet.actualRowCount
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r)
    if (isRowBlank(row, [nameCol!, categoryCol!, labelCol!, amountCol!])) {
      // Blank row — treat as end-of-data-ish but keep scanning: admins
      // sometimes leave gaps.
      continue
    }

    const rawName = cellText(row.getCell(nameCol!))
    const rawCategory = cellText(row.getCell(categoryCol!))
    const rawLabel = cellText(row.getCell(labelCol!))
    const rawAmount = cellNumeric(row.getCell(amountCol!))

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
    })
  }

  return { rows, errors: [], rowErrors }
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

function isRowBlank(row: ExcelJS.Row, columns: number[]): boolean {
  for (const c of columns) {
    const v = row.getCell(c).value
    if (v != null && String(v).trim().length > 0) return false
  }
  return true
}
