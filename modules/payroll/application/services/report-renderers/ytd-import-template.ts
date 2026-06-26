import "server-only"

import ExcelJS from "exceljs"

/**
 * YTD payroll-history import template — admins download this XLSX,
 * fill in past months' payroll values for each employee, and upload
 * it back to seed historical runs so the PCB engine has the right
 * cumulative YTD when computing the rest of the calendar year.
 *
 * Three sheets:
 *   1. "📕 Instructions"     — how to fill, format rules, gotchas.
 *   2. "✏️ YTD Data"          — pre-filled with the org's employees and
 *                              12 month rows per employee. Admin fills
 *                              the numeric columns. This is the sheet
 *                              the importer reads.
 *   3. "📗 YTD Data — Sample" — one example employee fully filled so
 *                              admins can see what a good row looks
 *                              like. Importer skips this sheet.
 *
 * Layout per employee (13 rows):
 *   Row N    : Header row — Full Name | Personal ID | YTD totals
 *              across the rest of the columns. Admin can leave the
 *              YTD totals blank; importer recomputes from month rows.
 *   Row N+1  : January
 *   Row N+2  : February
 *   ...
 *   Row N+12 : December
 *
 * Column order is fixed — the importer matches by header text, not
 * position, but keeping it stable means a row that worked last quarter
 * will still parse on the next quarter's upload.
 */

const BRAND_PURPLE = "FF5B21B6"
const BRAND_PURPLE_LIGHT = "FFE9D5FF"
const BRAND_PURPLE_FAINT = "FFF5F3FF"
const SAMPLE_GREEN = "FF22C55E"
const HEADER_TEXT = "FFFFFFFF"
const ZEBRA_TINT = "FFFAFAFA"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

const MANDATORY_COLUMNS = [
  "Full Name",
  "Personal ID",
  "Basic Salary",
  "PCB",
  "Employee EPF",
  "Employee SOCSO",
  "Employee EIS",
  "Employer EPF",
  "Employer SOCSO",
  "Employer EIS",
  "HRDF",
] as const

const OPTIONAL_COLUMNS = [
  "Bonus",
  "Commission",
  "Overtime",
  "Service Charge",
  "Travel/Petrol Allowance",
  "Parking Allowance",
  "Phone/Broadband Allowance",
  "Other Allowance",
  "Unpaid Leave",
  "Net Salary Deduction",
  "Zakat",
] as const

const NUM_FORMAT = "#,##0.00;(#,##0.00);-"

export type YtdImportTemplateEmployee = {
  name: string
  /// "NRIC: 001127-08-0576" or "Passport: A1234567" — we render
  /// whatever the admin set; importer parses it on upload.
  personalIdLabel: string
}

export type YtdImportTemplateInput = {
  organizationName: string
  year: number
  /// Pre-fills the Edit me! sheet with one block per employee. Empty
  /// array is fine — admin will type rows by hand or paste them in.
  employees: YtdImportTemplateEmployee[]
  /// When supplied, prepended to the Instructions sheet's title line.
  /// Useful when shipping a re-download with a hint like "Updated 19
  /// Jun 2026" — we don't auto-stamp dates here (the calc runtime
  /// disallows new Date() in some paths), pass an explicit string.
  generatedOn?: string
}

export async function renderYtdImportTemplate(
  input: YtdImportTemplateInput,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.lastModifiedBy = "AltomateHR"

  buildInstructionsSheet(wb, input)
  buildDataSheet(wb, input, {
    name: `✏️ YTD Data ${input.year}`,
    title: `✏️ YTD Data ${input.year}`,
    subtitle: input.organizationName,
    employees: input.employees,
    prefilledExample: false,
    tabColor: BRAND_PURPLE,
  })
  buildDataSheet(wb, input, {
    name: "📗 YTD Data — Sample",
    title: "📗 Sample YTD Data — reference only",
    subtitle: "Sample Sdn. Bhd.",
    employees: SAMPLE_EMPLOYEES,
    prefilledExample: true,
    tabColor: SAMPLE_GREEN,
  })

  // The Workbook type from exceljs returns its buffer as
  // `ArrayBuffer | Buffer` depending on environment; coerce to a Node
  // Buffer so route handlers can pass it straight to a Response.
  const out = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer)
}

// ───────────────────────────────────────────────────────────────────
// Instructions sheet
// ───────────────────────────────────────────────────────────────────

function buildInstructionsSheet(
  wb: ExcelJS.Workbook,
  input: YtdImportTemplateInput,
) {
  const ws = wb.addWorksheet("📕 Instructions", {
    properties: { tabColor: { argb: BRAND_PURPLE } },
  })

  ws.getColumn(1).width = 2
  ws.getColumn(2).width = 28
  ws.getColumn(3).width = 70

  // Title band
  ws.mergeCells("B2:C2")
  const title = ws.getCell("B2")
  title.value = `📕 YTD payroll-history import — Instructions${
    input.generatedOn ? ` (${input.generatedOn})` : ""
  }`
  title.font = { bold: true, size: 14, color: { argb: HEADER_TEXT } }
  title.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_PURPLE },
  }
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 }
  ws.getRow(2).height = 28

  const sections: Array<{ heading: string; body: string[] }> = [
    {
      heading: "What this file is for",
      body: [
        "Use this template when you start using AltomateHR mid-year and need to bring in payroll history from your previous system. The PCB engine uses each employee's year-to-date totals to calculate the right tax for the rest of the year — without this, the first run after migration will under- or over-deduct.",
      ],
    },
    {
      heading: "How to fill it",
      body: [
        `Open the "✏️ YTD Data ${input.year}" sheet — your employees are already listed.`,
        "For each employee, fill the 12 month rows below the header row with what was actually paid that month. Leave a month blank or 0 if no payroll happened that month (e.g. employee joined in March → Jan and Feb stay 0).",
        "The header row's YTD totals are for your reference — the importer recomputes them from the month rows.",
      ],
    },
    {
      heading: "Mandatory columns",
      body: [
        "Basic Salary, PCB, Employee EPF, Employee SOCSO, Employee EIS, Employer EPF, Employer SOCSO, Employer EIS, HRDF.",
        "Leave 0 if not applicable (e.g. HRDF = 0 for foreign workers; EIS = 0 if employee is over 60).",
      ],
    },
    {
      heading: "Optional columns",
      body: [
        "Each optional column header must match one of the supported labels exactly (case-insensitive). Add columns for the categories you actually paid; delete the ones you don't.",
        "Quick-pick (the columns this template starts with):",
        "  • Bonus · Commission · Overtime · Service Charge",
        "  • Travel/Petrol Allowance (also: \"Travel Allowance\", \"Petrol Allowance\")",
        "  • Parking Allowance",
        "  • Phone/Broadband Allowance (also: \"Phone Allowance\", \"Broadband Allowance\")",
        "  • Other Allowance · Unpaid Leave · Net Salary Deduction · Zakat",
        "Full category list (any of these labels also works — same set the per-run adjustment form on the run-detail page offers):",
        "  • Remuneration: Annual Bonus, Non-Annual Bonus, Commission, Incentive, Arrears, Service Charge, Leave Pay, Gratuity, Compensation for Loss of Employment, Ex-Gratia, Tax Borne By Employer, Director Fee",
        "  • Allowances: Standard Allowance, Travel/Petrol/Toll (Official Duty), Travel/Petrol Allowance (Private Use/Commuting), Parking Allowance, Meal Allowance, Childcare Allowance, Phone/Internet Bill Payment, Phone Allowance (Fixed)",
        "  • Benefits-in-Kind (non-cash, doesn't reduce net): Car/Petrol BIK, Medical/Dental Benefit, Award, Living Accommodation, Share Scheme, Subsidised Loan, Phone/PDA Gift, Other Exempt Benefit",
        "  • Deductions: Unpaid Leave (reduces gross), Salary Adjustment, Advance, CP38 (PCB Adjustment), Zakat (payroll), Zakat (TP1), TP1 Deduction",
        "Each label routes the amount via that category's statutory rules — e.g. a BIK column lands as non-cash (counts toward PCB taxable income but doesn't reduce net), a CP38 column flows to the PCB-deduction bucket, etc. The mandatory PCB/EPF/SOCSO/EIS/HRDF columns above are still taken as you typed them — the optional columns only feed the imported payslip's display breakdown + next month's YTD aggregator.",
      ],
    },
    {
      heading: "Conflict handling",
      body: [
        "On upload: any month that already has a submitted payroll run in AltomateHR for that employee is SKIPPED (we won't overwrite real run history).",
        "Employees whose NRIC / Passport doesn't match an existing AltomateHR employee are SKIPPED — the upload summary lists them so you can add them and re-upload.",
      ],
    },
    {
      heading: "Format rules",
      body: [
        "Amounts are in Malaysian Ringgit, 2 decimal places. Use 0 not blank.",
        "Personal ID format: NRIC: 001127-08-0576 or Passport: A1234567 — keep the prefix.",
        "Don't delete or rename the mandatory columns. Optional columns can be deleted if unused; renaming or adding new column names is NOT supported — use 'Other Allowance' for anything that doesn't fit the listed labels.",
      ],
    },
  ]

  let r = 4
  for (const sec of sections) {
    const head = ws.getCell(`B${r}`)
    head.value = sec.heading
    head.font = { bold: true, size: 12, color: { argb: BRAND_PURPLE } }
    r++
    for (const line of sec.body) {
      ws.mergeCells(`B${r}:C${r}`)
      const cell = ws.getCell(`B${r}`)
      cell.value = line
      cell.alignment = { wrapText: true, vertical: "top" }
      cell.font = { size: 11 }
      ws.getRow(r).height = Math.max(20, Math.ceil(line.length / 80) * 18)
      r++
    }
    r++ // blank row between sections
  }
}

// ───────────────────────────────────────────────────────────────────
// Data sheets (Edit me + Sample share this builder)
// ───────────────────────────────────────────────────────────────────

type DataSheetConfig = {
  name: string
  title: string
  subtitle: string
  employees: YtdImportTemplateEmployee[]
  prefilledExample: boolean
  tabColor: string
}

function buildDataSheet(
  wb: ExcelJS.Workbook,
  input: YtdImportTemplateInput,
  cfg: DataSheetConfig,
) {
  const ws = wb.addWorksheet(cfg.name, {
    properties: { tabColor: { argb: cfg.tabColor } },
    views: [{ state: "frozen", xSplit: 2, ySplit: 5 }],
  })

  const allColumns = [...MANDATORY_COLUMNS, ...OPTIONAL_COLUMNS]

  // Column widths — first two are identity, rest are numeric.
  ws.getColumn(1).width = 26
  ws.getColumn(2).width = 24
  for (let i = 3; i <= allColumns.length; i++) {
    ws.getColumn(i).width = 16
  }

  // ── Row 1: title band
  ws.mergeCells(1, 1, 1, allColumns.length)
  const title = ws.getCell(1, 1)
  title.value = cfg.title
  title.font = { bold: true, size: 14, color: { argb: HEADER_TEXT } }
  title.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_PURPLE },
  }
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 }
  ws.getRow(1).height = 28

  // ── Row 2: subtitle
  ws.mergeCells(2, 1, 2, allColumns.length)
  const subtitle = ws.getCell(2, 1)
  subtitle.value = cfg.subtitle
  subtitle.font = { italic: true, color: { argb: BRAND_PURPLE } }
  subtitle.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_PURPLE_FAINT },
  }
  subtitle.alignment = { vertical: "middle", horizontal: "left", indent: 1 }
  ws.getRow(2).height = 20

  // ── Row 3: spacer
  ws.getRow(3).height = 8

  // ── Row 4: section bands (MANDATORY / OPTIONAL)
  const mandatoryStart = 3 // column index after Name + Personal ID
  const mandatoryEnd = MANDATORY_COLUMNS.length // 11
  const optionalStart = mandatoryEnd + 1
  const optionalEnd = allColumns.length

  ws.mergeCells(4, mandatoryStart, 4, mandatoryEnd)
  const mandBand = ws.getCell(4, mandatoryStart)
  mandBand.value = "MANDATORY — do not remove or rename"
  mandBand.font = { bold: true, size: 11, color: { argb: HEADER_TEXT } }
  mandBand.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_PURPLE },
  }
  mandBand.alignment = { vertical: "middle", horizontal: "center" }

  ws.mergeCells(4, optionalStart, 4, optionalEnd)
  const optBand = ws.getCell(4, optionalStart)
  optBand.value =
    "OPTIONAL — delete unused columns · don't rename or invent new ones · order doesn't matter"
  optBand.font = { bold: true, size: 11, color: { argb: BRAND_PURPLE } }
  optBand.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_PURPLE_LIGHT },
  }
  optBand.alignment = { vertical: "middle", horizontal: "center" }
  ws.getRow(4).height = 22

  // ── Row 5: column headers
  for (let c = 1; c <= allColumns.length; c++) {
    const cell = ws.getCell(5, c)
    cell.value = allColumns[c - 1]
    cell.font = { bold: true, color: { argb: HEADER_TEXT } }
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: BRAND_PURPLE },
    }
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 }
    cell.border = {
      bottom: { style: "thin", color: { argb: BRAND_PURPLE } },
    }
  }
  ws.getRow(5).height = 30

  // ── Employee blocks
  let r = 6
  for (let i = 0; i < cfg.employees.length; i++) {
    const emp = cfg.employees[i]!
    const blockTint = i % 2 === 1 ? ZEBRA_TINT : null
    r = writeEmployeeBlock(ws, r, emp, allColumns.length, blockTint, {
      prefilled: cfg.prefilledExample,
    })
  }
}

function writeEmployeeBlock(
  ws: ExcelJS.Worksheet,
  startRow: number,
  emp: YtdImportTemplateEmployee,
  totalCols: number,
  tint: string | null,
  opts: { prefilled: boolean },
): number {
  // Header row: Name | Personal ID | YTD totals (formulas)
  const headerRow = ws.getRow(startRow)
  headerRow.getCell(1).value = emp.name
  headerRow.getCell(2).value = emp.personalIdLabel
  headerRow.getCell(1).font = { bold: true, color: { argb: BRAND_PURPLE } }
  headerRow.getCell(2).font = { color: { argb: BRAND_PURPLE } }

  // YTD totals across numeric columns — formula summing the 12
  // months below. Auto-recalcs as admin fills the months.
  for (let c = 3; c <= totalCols; c++) {
    const colLetter = ws.getColumn(c).letter
    const monthStart = startRow + 1
    const monthEnd = startRow + 12
    const cell = headerRow.getCell(c)
    cell.value = {
      formula: `SUM(${colLetter}${monthStart}:${colLetter}${monthEnd})`,
      result: 0,
    }
    cell.numFmt = NUM_FORMAT
    cell.font = { bold: true }
  }

  // Light tint + thick top border to separate employees
  for (let c = 1; c <= totalCols; c++) {
    const cell = headerRow.getCell(c)
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: BRAND_PURPLE_FAINT },
    }
    cell.border = {
      top: { style: "medium", color: { argb: BRAND_PURPLE } },
      bottom: { style: "thin", color: { argb: BRAND_PURPLE_LIGHT } },
    }
  }
  headerRow.height = 22

  // 12 month rows
  for (let m = 0; m < 12; m++) {
    const row = ws.getRow(startRow + 1 + m)
    row.getCell(1).value = MONTHS[m]
    row.getCell(1).font = { color: { argb: "FF6B7280" }, italic: true }
    // Personal ID column stays blank on month rows
    for (let c = 3; c <= totalCols; c++) {
      const cell = row.getCell(c)
      cell.value = opts.prefilled ? sampleMonthValue(m, c) : null
      cell.numFmt = NUM_FORMAT
    }
    if (tint) {
      for (let c = 1; c <= totalCols; c++) {
        row.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: tint },
        }
      }
    }
    row.height = 18
  }

  // +13 = 1 header row + 12 month rows
  return startRow + 13
}

function sampleMonthValue(monthIdx: number, colIdx: number): number | null {
  // Only fill May–Dec on the sample (matches the "mid-year cutover"
  // story — Jan–Apr were paid on the old system, the rest stays 0 so
  // admins can see what month rows look like both populated and empty).
  if (monthIdx < 4) return 0
  // colIdx is 1-based; 1=Name, 2=ID, 3=Basic Salary, 4=PCB, 5=EPF emp,
  // 6=SOCSO emp, 7=EIS emp, 8=EPF er, 9=SOCSO er, 10=EIS er, 11=HRDF
  switch (colIdx) {
    case 3:
      return 5000 // Basic salary
    case 4:
      return monthIdx === 11 ? 245.6 : 124.3 // PCB
    case 5:
      return 715 // Employee EPF
    case 6:
      return 24.75 // Employee SOCSO
    case 7:
      return 9.9 // Employee EIS
    case 8:
      return 785 // Employer EPF
    case 9:
      return 86.65 // Employer SOCSO
    case 10:
      return 9.9 // Employer EIS
    case 11:
      return 50 // HRDF
    default:
      return null
  }
}

// One pre-rolled employee for the Sample sheet so admins see what a
// fully-filled row should look like before they touch the live sheet.
const SAMPLE_EMPLOYEES: YtdImportTemplateEmployee[] = [
  {
    name: "Ali bin Ahmad",
    personalIdLabel: "NRIC: 901231-12-3456",
  },
]
