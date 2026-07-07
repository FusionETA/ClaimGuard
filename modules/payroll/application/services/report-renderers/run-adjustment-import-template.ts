import "server-only"

import ExcelJS from "exceljs"

import { listCategoryLabels } from "@/modules/payroll/application/services/report-renderers/run-adjustment-import-parser"

/**
 * Builds a downloadable XLSX template for bulk-importing per-run
 * adjustments. Layout:
 *
 *   Sheet 1 "Adjustments" — the file the admin uploads
 *   Sheet 2 "Categories"  — reference list of every accepted category
 *                            label, for admins who don't want to type
 *                            from memory
 *
 * The Adjustments sheet is pre-populated with one example row per
 * employee on the run — admins usually just edit amounts in-place.
 */
export async function renderAdjustmentImportTemplate(input: {
  periodLabel: string
  employees: Array<{ name: string; jobTitle: string | null }>
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.created = new Date(0)

  // ── Adjustments sheet ─────────────────────────────────────────────
  const sheet = wb.addWorksheet("Adjustments", {
    views: [{ state: "frozen", ySplit: 1 }],
  })

  sheet.columns = [
    { header: "Full Name", key: "name", width: 30 },
    { header: "Category", key: "category", width: 40 },
    { header: "Label", key: "label", width: 32 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Notes", key: "notes", width: 40 },
  ]

  // Header row styling — light background so admins visually anchor
  // the header.
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEAFC" },
  }
  headerRow.alignment = { vertical: "middle" }

  // Example / placeholder rows — one per employee on the run, but
  // with empty category/label/amount so nothing accidentally imports
  // if the admin just clicks upload without editing. If the run has
  // no employees, drop a single hint row so the template still shows
  // the shape.
  const rows =
    input.employees.length > 0
      ? input.employees.map((e) => [
          e.name,
          "",
          "",
          "",
          e.jobTitle ? `Job: ${e.jobTitle}` : "",
        ])
      : [
          [
            "Ali bin Ahmad",
            "Standard Allowance",
            "January transport top-up",
            250.0,
            "example row — delete before uploading",
          ],
        ]

  for (const r of rows) sheet.addRow(r)

  // Amount column: currency format so the file looks right when the
  // admin types numbers.
  sheet.getColumn(4).numFmt = "#,##0.00"

  // Freeze row 1 already set via `views`; also set autoFilter for
  // convenience.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 5 },
  }

  // Period label — put it in a comment on the header so re-uploading
  // to a different month is at least visible in the file's provenance.
  sheet.getCell("A1").note = {
    texts: [
      {
        text: `Bulk-adjustment template for the ${input.periodLabel} payroll run.\nUploading this file REPLACES every existing one-off adjustment on the run.`,
      },
    ],
  }

  // ── Categories reference sheet ────────────────────────────────────
  const ref = wb.addWorksheet("Categories")
  ref.columns = [{ header: "Accepted Category label", key: "label", width: 60 }]
  ref.getRow(1).font = { bold: true }
  for (const label of listCategoryLabels()) ref.addRow([label])

  const arrayBuffer = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer as ArrayBuffer)
}
