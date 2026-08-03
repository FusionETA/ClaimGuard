import "server-only"

import ExcelJS from "exceljs"

import type {
  DailyAttendanceDay,
  DailyAttendanceReport,
} from "@/modules/attendance/application/services/attendance-daily-export.service"

/**
 * Excel renderer for the day-by-day attendance report — one worksheet per
 * day, named after the date.
 *
 * Layout mirrors the client's existing workbook (merged title banner,
 * merged company banner, bordered table) with the source file's teal
 * swapped for the AltomateHR primary.
 */

/** `--primary: 268 68% 31%` from app/globals.css. */
const BRAND = "FF4C1A86"
const BRAND_TEXT = "FFFFFFFF"
const BORDER = "FFBFBFBF"

const COLUMNS: Array<{ header: string; width: number }> = [
  { header: "NO", width: 5 },
  { header: "NAME", width: 42 },
  { header: "DESIGNATION", width: 30 },
  { header: "DEPARTMENT", width: 20 },
  { header: "CHECKED-IN", width: 15 },
  { header: "CHECKED-OUT", width: 16 },
  { header: "LEAVE STATUS", width: 36 },
]

const LAST_COL = String.fromCharCode(64 + COLUMNS.length) // "G"

const thin: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: BORDER } },
  left: { style: "thin", color: { argb: BORDER } },
  bottom: { style: "thin", color: { argb: BORDER } },
  right: { style: "thin", color: { argb: BORDER } },
}

function bannerRow(
  ws: ExcelJS.Worksheet,
  rowNumber: number,
  text: string,
  fontSize: number,
  height: number,
) {
  ws.mergeCells(`A${rowNumber}:${LAST_COL}${rowNumber}`)
  const cell = ws.getCell(`A${rowNumber}`)
  cell.value = text
  cell.font = { bold: true, size: fontSize, color: { argb: BRAND_TEXT } }
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } }
  cell.alignment = { horizontal: "center", vertical: "middle" }
  cell.border = thin
  ws.getRow(rowNumber).height = height
}

/**
 * Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 chars.
 * Dates are safe once the dashes stay, but guard anyway — a duplicate or
 * illegal name throws at write time, losing the whole workbook.
 */
function safeSheetName(date: string, used: Set<string>): string {
  const base = date.replace(/[:\\/?*[\]]/g, "-").slice(0, 31)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`
    const candidate = base.slice(0, 31 - suffix.length) + suffix
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

function renderDay(
  wb: ExcelJS.Workbook,
  day: DailyAttendanceDay,
  organizationName: string,
  used: Set<string>,
) {
  const ws = wb.addWorksheet(safeSheetName(day.date, used), {
    // Freeze through the header row (4) so it stays visible while
    // scrolling a 200-employee day.
    views: [{ state: "frozen", ySplit: 4 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })

  ws.columns = COLUMNS.map((c) => ({ width: c.width }))

  bannerRow(ws, 1, `ATTENDANCE - ${day.dateLabel}`, 18, 32)
  ws.getRow(2).height = 7
  bannerRow(ws, 3, organizationName, 16, 28)

  const header = ws.getRow(4)
  COLUMNS.forEach((col, i) => {
    const cell = header.getCell(i + 1)
    cell.value = col.header
    cell.font = { bold: true, size: 11 }
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }
    cell.border = thin
  })
  header.height = 24

  day.rows.forEach((row, i) => {
    const r = ws.getRow(5 + i)
    const values = [
      row.no,
      row.name,
      row.designation,
      row.department,
      row.checkedIn,
      row.checkedOut,
      row.leaveStatus,
    ]
    values.forEach((value, c) => {
      const cell = r.getCell(c + 1)
      cell.value = value
      cell.font = { size: 11 }
      cell.alignment = {
        // Name and designation read as text; everything else is a short
        // token that looks wrong ragged-left in a narrow column.
        horizontal: c === 1 || c === 2 ? "left" : "center",
        vertical: "middle",
        wrapText: c === 6,
      }
      cell.border = thin
    })
  })

  // Header row stays filterable — HR tends to sort by check-in time.
  ws.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4 + day.rows.length, column: COLUMNS.length },
  }
}

export async function renderDailyAttendanceExcel(
  report: DailyAttendanceReport,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.created = new Date()

  const used = new Set<string>()
  for (const day of report.days) {
    renderDay(wb, day, report.organizationName, used)
  }

  // A range with no days at all would produce a workbook with zero
  // sheets, which Excel refuses to open.
  if (report.days.length === 0) {
    const ws = wb.addWorksheet("No data")
    ws.getCell("A1").value = "No days in the selected range."
  }

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}
