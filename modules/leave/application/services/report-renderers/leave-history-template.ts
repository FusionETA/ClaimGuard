import "server-only"

import ExcelJS from "exceljs"

import { LEAVE_HISTORY_COLUMNS } from "@/modules/leave/application/services/leave-history-import.service"

/**
 * Styled XLSX template for the leave-history importer. Mirrors the
 * employee import template's look: a bold colour-coded header (frozen,
 * `*`-required markers), dropdowns on Leave Type + Status, a Read Me
 * sheet, and a filled Example row. Solid fills only.
 */

const HEADER_FILL = "FF5B21B6" // brand purple
const HEADER_TEXT = "FFFFFFFF"
const STATUS_OPTIONS = ["APPROVED", "PENDING", "REJECTED", "CANCELLED"]

// ExcelJS's ranged list-validation lives on the internal `dataValidations`
// model, which its published types don't expose — narrow cast so we emit
// one <dataValidation> per column range.
type RangedDataValidations = {
  add(
    sqref: string,
    v: {
      type: "list"
      allowBlank?: boolean
      formulae?: string[]
      showErrorMessage?: boolean
      errorStyle?: "stop" | "warning" | "information"
      error?: string
    },
  ): void
}
function dvOf(ws: ExcelJS.Worksheet): RangedDataValidations {
  return (ws as unknown as { dataValidations: RangedDataValidations })
    .dataValidations
}

function styleSheet(ws: ExcelJS.Worksheet, leaveTypeNames: string[]): void {
  ws.views = [{ state: "frozen", ySplit: 1 }]
  ws.getRow(1).height = 24
  LEAVE_HISTORY_COLUMNS.forEach((col, i) => {
    const c = i + 1
    const label = col.label + (col.required ? " *" : "")
    const cell = ws.getCell(1, c)
    cell.value = label
    cell.font = { bold: true, color: { argb: HEADER_TEXT } }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } }
    cell.alignment = { vertical: "middle", horizontal: "left" }
    ws.getColumn(c).width = Math.min(34, Math.max(14, label.length + 4))

    let opts: string[] | null = null
    if (col.key === "status") opts = STATUS_OPTIONS
    else if (col.key === "leaveType" && leaveTypeNames.length > 0) opts = leaveTypeNames
    // Inline list formulae cap out ~255 chars — fall back to free text.
    if (opts && opts.join(",").length <= 250) {
      const letter = ws.getColumn(c).letter
      dvOf(ws).add(`${letter}2:${letter}2000`, {
        type: "list",
        allowBlank: true,
        formulae: [`"${opts.join(",")}"`],
        showErrorMessage: col.key === "status",
        errorStyle: "warning",
        error: `Pick one of: ${opts.join(", ")}`,
      })
    }
  })
}

function addReadMe(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet("📋 Read Me")
  ws.getColumn(1).width = 3
  ws.getColumn(2).width = 100
  const put = (t: string, f?: Partial<ExcelJS.Font>) => {
    const r = ws.addRow(["", t])
    if (f) r.getCell(2).font = f
  }
  put("Import leave history", { bold: true, size: 16, color: { argb: HEADER_FILL } })
  put("")
  put("How to use", { bold: true, size: 12 })
  put("1. Fill one row per past leave application on the “Leave History” sheet (from row 2).")
  put("2. Columns marked * are required. Match Employee Email + Leave Type to existing records.")
  put("3. Dates use YYYY-MM-DD. Days is the number taken (0.5 for a half day).")
  put("4. Status: APPROVED counts against the balance; PENDING reserves it; REJECTED / CANCELLED don’t.")
  put("5. Re-uploading is safe — rows already imported (same employee + type + dates) are skipped.")
  put("")
  put("Note", { bold: true, size: 12 })
  put("This imports the leave TAKEN (the “used” side). Set each employee’s entitlement (annual days + carry-forward) separately so the remaining balance lands right.", { color: { argb: "FF6B7280" } })
}

function addExample(wb: ExcelJS.Workbook, leaveTypeNames: string[]): void {
  const ws = wb.addWorksheet("Example")
  styleSheet(ws, leaveTypeNames)
  const row = ws.addRow(LEAVE_HISTORY_COLUMNS.map((c) => c.example ?? ""))
  row.eachCell((cell) => {
    cell.font = { italic: true, color: { argb: "FF6B7280" } }
  })
}

export async function buildLeaveHistoryTemplateBuffer(opts: {
  leaveTypeNames: string[]
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.created = new Date(0)

  addReadMe(wb)
  const ws = wb.addWorksheet("Leave History")
  styleSheet(ws, opts.leaveTypeNames)
  addExample(wb, opts.leaveTypeNames)

  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
