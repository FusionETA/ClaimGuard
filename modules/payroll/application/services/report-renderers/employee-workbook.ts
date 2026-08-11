import "server-only"

import ExcelJS from "exceljs"

import {
  EMPLOYEE_IMPORT_COLUMNS,
  EMPLOYEE_IMPORT_GROUPS,
  type EmployeeImportGroup,
  columnGroup,
  columnLabel,
  columnMeta,
} from "@/modules/payroll/domain/employee-import-columns"

/**
 * Shared styled-XLSX builder for the employee bulk-import template AND
 * the employee export — one design, one source of truth.
 *
 *   - `mode: "template"` → a "Read Me" sheet, a blank "Employees" sheet
 *     (header only), and a filled "Example" sheet.
 *   - `mode: "export"`  → just the "Employees" sheet, header + real rows.
 *
 * The "Employees" sheet is identical in both modes: friendly header
 * labels (row 1, frozen), colour-coded by column group, required columns
 * marked with `*`, sensible widths, and dropdown validation on the enum
 * columns. The importer reads THIS sheet, header on row 1 — so an export
 * is directly re-importable. Solid fills only (no gradients).
 */

const HEADER_TEXT = "FFFFFFFF"
const GROUP_COLOR: Record<EmployeeImportGroup, string> = {
  "Identity & Employment": "FF5B21B6", // brand purple
  "Personal & Contact": "FF2563EB", // blue
  Spouse: "FF7C3AED", // violet
  "Statutory & Payroll": "FF0F766E", // teal
  Bank: "FFB45309", // amber
  Assignment: "FFBE123C", // rose
  "Dependent Children": "FF4B5563", // slate
}

/// Dropdown options per column key. Applied as Excel list validation so
/// admins pick valid values instead of guessing. Keep in sync with the
/// enums the importer accepts.
const ENUM_OPTIONS: Record<string, string[]> = {
  employeeType: ["EMPLOYEE", "SUPERVISOR"],
  gender: ["MALE", "FEMALE"],
  race: ["M", "C", "I", "O"],
  maritalStatus: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"],
  idType: ["NRIC", "PASSPORT", "ARMY_NO", "POLICE_NO"],
  salaryType: ["MONTHLY", "HOURLY"],
  socsoScheme: ["EMPLOYMENT_INJURY_INVALIDITY", "EMPLOYMENT_INJURY_ONLY"],
  paymentMethod: ["BANK_TRANSFER", "CASH", "CHEQUE"],
}
const BOOLEAN_KEYS = new Set([
  "reportedToLhdn", "hasPr", "isResident", "isOku", "spouseWorking",
  "spouseDisabled", "contributeToEpf", "epfMemberBefore1998",
  "pcbBorneByEmployer", "contributeToEis", "contributeToSkbbk",
])
const CHILD_ENUM_SUBFIELDS: Record<string, string[]> = {
  abilityStatus: ["NORMAL", "DISABLED"],
  currentlyStudying: ["UNDER_18", "PRE_UNIVERSITY", "DIPLOMA_MALAYSIA", "DEGREE_ABROAD"],
  pcbDeduction: ["FULL", "HALF", "NONE"],
}

function optionsForKey(key: string): string[] | null {
  if (BOOLEAN_KEYS.has(key)) return ["TRUE", "FALSE"]
  if (ENUM_OPTIONS[key]) return ENUM_OPTIONS[key]
  const m = key.match(/^child\d+\.(\w+)$/)
  if (m && CHILD_ENUM_SUBFIELDS[m[1]]) return CHILD_ENUM_SUBFIELDS[m[1]]
  return null
}

// ExcelJS supports ranged list-validation via the worksheet's internal
// `dataValidations` model, which its published types don't expose. Narrow
// cast so we emit ONE <dataValidation> per column range (small file)
// rather than per-cell.
type RangedDataValidations = {
  add(
    sqref: string,
    validation: {
      type: "list"
      allowBlank?: boolean
      formulae?: string[]
      showErrorMessage?: boolean
      errorStyle?: "stop" | "warning" | "information"
      error?: string
    },
  ): void
}
function dataValidationsOf(ws: ExcelJS.Worksheet): RangedDataValidations {
  return (ws as unknown as { dataValidations: RangedDataValidations })
    .dataValidations
}

/// Freeze row 1, style the header, size columns, add dropdowns.
function styleEmployeeSheet(ws: ExcelJS.Worksheet): void {
  ws.views = [{ state: "frozen", ySplit: 1 }]
  const headerRow = ws.getRow(1)
  headerRow.height = 26

  EMPLOYEE_IMPORT_COLUMNS.forEach((col, i) => {
    const c = i + 1
    const label = columnLabel(col.key) + (col.required ? " *" : "")
    const cell = ws.getCell(1, c)
    cell.value = label
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 }
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: GROUP_COLOR[columnGroup(col.key)] },
    }
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: false }
    cell.border = { bottom: { style: "thin", color: { argb: "FFFFFFFF" } } }

    // Column width from the label length, clamped to a readable range.
    ws.getColumn(c).width = Math.min(30, Math.max(13, label.length + 2))

    // Dropdown validation on the fillable rows for enum columns.
    const opts = optionsForKey(col.key)
    if (opts) {
      const letter = ws.getColumn(c).letter
      dataValidationsOf(ws).add(`${letter}2:${letter}1000`, {
        type: "list",
        allowBlank: true,
        formulae: [`"${opts.join(",")}"`],
        showErrorMessage: true,
        errorStyle: "warning",
        error: `Pick one of: ${opts.join(", ")}`,
      })
    }
  })
}

function addReadMeSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet("📋 Read Me")
  ws.getColumn(1).width = 3
  ws.getColumn(2).width = 100
  const put = (text: string, style?: Partial<ExcelJS.Font>) => {
    const row = ws.addRow(["", text])
    if (style) row.getCell(2).font = style
  }
  put("Employee bulk-import template", { bold: true, size: 16, color: { argb: "FF5B21B6" } })
  put("")
  put("How to use", { bold: true, size: 12 })
  put("1. Go to the “Employees” sheet and fill one row per employee (start on row 2).")
  put("2. Columns marked with * are required. Everything else is optional.")
  put("3. Where a cell has a dropdown, pick from the list — those values must match exactly.")
  put("4. Dates use the format YYYY-MM-DD (e.g. 2024-01-15). TRUE/FALSE for yes-no columns.")
  put("5. See the “Example” sheet for one fully-filled employee.")
  put("6. Upload the finished file back on the same import screen (.xlsx or .csv both work).")
  put("")
  put("Column groups (matched by the header colour)", { bold: true, size: 12 })
  for (const g of EMPLOYEE_IMPORT_GROUPS) {
    const row = ws.addRow(["", g])
    const cell = row.getCell(2)
    cell.font = { bold: true, color: { argb: HEADER_TEXT } }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GROUP_COLOR[g] } }
  }
}

function addExampleSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet("Example")
  styleEmployeeSheet(ws)
  const example = EMPLOYEE_IMPORT_COLUMNS.map((col) => columnMeta(col.key).example ?? "")
  const row = ws.addRow(example)
  row.eachCell((cell) => {
    cell.font = { italic: true, color: { argb: "FF6B7280" } }
  })
}

export async function buildEmployeeWorkbookBuffer(opts: {
  mode: "template" | "export"
  /// Real employee rows for export, in EMPLOYEE_IMPORT_COLUMNS order.
  dataRows?: string[][]
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.created = new Date(0) // deterministic; avoids Date.now noise

  if (opts.mode === "template") addReadMeSheet(wb)

  const ws = wb.addWorksheet("Employees")
  styleEmployeeSheet(ws)
  for (const r of opts.dataRows ?? []) ws.addRow(r)

  if (opts.mode === "template") addExampleSheet(wb)

  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
