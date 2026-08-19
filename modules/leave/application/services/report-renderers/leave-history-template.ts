import "server-only"

import ExcelJS from "exceljs"

import { LEAVE_HISTORY_COLUMNS } from "@/modules/leave/application/services/leave-history-import.service"
import { LEAVE_BALANCE_COLUMNS } from "@/modules/leave/application/services/leave-balance-import.service"

/**
 * Styled XLSX template for the leave migration. Two data tabs:
 *   • "Leave Balances" — the simple path: just the closing figures
 *     (entitled / carry-forward / taken) per employee + leave type.
 *   • "Leave History" — optional: one row per past application, for
 *     admins who want the full detail on record.
 * Fill either or both; the importer reads whichever tab has data. Mirrors
 * the employee-import look: bold colour-coded frozen header, `*`-required
 * markers, Leave-Type / Status dropdowns, a Read Me + Example sheet.
 * Solid fills only.
 */

const HEADER_FILL = "FF5B21B6" // brand purple
const HEADER_TEXT = "FFFFFFFF"
const STATUS_OPTIONS = ["APPROVED", "PENDING", "REJECTED", "CANCELLED"]

type Column = { readonly key: string; readonly label: string; readonly required: boolean; readonly example?: string }

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

function styleSheet(
  ws: ExcelJS.Worksheet,
  columns: readonly Column[],
  leaveTypeNames: string[],
): void {
  ws.views = [{ state: "frozen", ySplit: 1 }]
  ws.getRow(1).height = 24
  columns.forEach((col, i) => {
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
  put("Migrate leave", { bold: true, size: 16, color: { argb: HEADER_FILL } })
  put("")
  put("Pick the tab that suits you — you can fill one or both.", { bold: true, size: 12 })
  put("")
  put("① Leave Balances  (the simple path)", { bold: true, size: 12 })
  put("Just the closing figures — one row per employee + leave type.")
  put("• Employee Name is matched to your staff automatically — case and spacing don’t matter. Email is optional: only add it if two staff share the same name.")
  put("• Entitled Days: the year's quota. Carried Forward: brought-in from last year. Taken: days already used.")
  put("• Remaining is worked out for you: Entitled + Carried Forward − Taken.")
  put("• Year is optional — defaults to the current year if blank.")
  put("• Re-uploading is safe: it re-sets the same figures (it overwrites, never doubles).")
  put("")
  put("② Leave History  (optional — full detail)", { bold: true, size: 12 })
  put("One row per past leave application. Use this only if you want every application on record.")
  put("• Dates use YYYY-MM-DD. Days is the number taken (0.5 for a half day).")
  put("• Status: APPROVED counts against the balance; PENDING reserves it; REJECTED / CANCELLED don’t.")
  put("• Re-uploading is safe — rows already imported (same employee + type + dates) are skipped.")
  put("")
  put("Tip", { bold: true, size: 12 })
  put("Use Balances OR History for a given employee + leave type — not both — so the days-taken aren’t counted twice.", { color: { argb: "FF6B7280" } })
}

function addExample(wb: ExcelJS.Workbook, leaveTypeNames: string[]): void {
  const ws = wb.addWorksheet("Example")
  ws.getColumn(1).width = 3

  const title = (t: string) => {
    const r = ws.addRow(["", t])
    r.getCell(2).font = { bold: true, size: 12, color: { argb: HEADER_FILL } }
  }
  const headerRow = (columns: readonly Column[]) => {
    const r = ws.addRow(["", ...columns.map((c) => c.label + (c.required ? " *" : ""))])
    r.eachCell((cell, col) => {
      if (col === 1) return
      cell.font = { bold: true, color: { argb: HEADER_TEXT } }
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } }
    })
  }
  const exampleRow = (columns: readonly Column[]) => {
    const r = ws.addRow(["", ...columns.map((c) => c.example ?? "")])
    r.eachCell((cell, col) => {
      if (col === 1) return
      cell.font = { italic: true, color: { argb: "FF6B7280" } }
    })
  }

  for (let c = 2; c <= 9; c++) ws.getColumn(c).width = 18

  title("Leave Balances — example")
  headerRow(LEAVE_BALANCE_COLUMNS)
  exampleRow(LEAVE_BALANCE_COLUMNS)
  ws.addRow([])
  title("Leave History — example")
  headerRow(LEAVE_HISTORY_COLUMNS)
  exampleRow(LEAVE_HISTORY_COLUMNS)

  // Keep a reference to leaveTypeNames so the signature matches callers even
  // when there are no types yet (dropdowns live on the data sheets).
  void leaveTypeNames
}

export async function buildLeaveHistoryTemplateBuffer(opts: {
  leaveTypeNames: string[]
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.created = new Date(0)

  addReadMe(wb)

  const balances = wb.addWorksheet("Leave Balances")
  styleSheet(balances, LEAVE_BALANCE_COLUMNS, opts.leaveTypeNames)

  const history = wb.addWorksheet("Leave History")
  styleSheet(history, LEAVE_HISTORY_COLUMNS, opts.leaveTypeNames)

  addExample(wb, opts.leaveTypeNames)

  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
