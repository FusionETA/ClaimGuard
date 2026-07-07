import "server-only"

import ExcelJS from "exceljs"

import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategoryMeta,
} from "@/modules/payroll/domain/models"

/**
 * Builds a downloadable XLSX template for bulk-importing per-run
 * adjustments. Layout:
 *
 *   Sheet 1 "Adjustments" — the file the admin uploads. Category
 *                            column has a dropdown validation sourced
 *                            from the Categories sheet.
 *   Sheet 2 "Categories"  — reference sheet listing every accepted
 *                            category and its statutory flags (EPF /
 *                            SOCSO / EIS / PCB / HRDF), tax-exempt
 *                            limit, and special-behaviour notes.
 *
 * Multiple adjustments per employee — the admin just adds another row
 * with the same Full Name. The parser groups by name and appends every
 * matching row into that employee's `manualLineItems` array.
 */
export async function renderAdjustmentImportTemplate(input: {
  periodLabel: string
  employees: Array<{ name: string }>
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "AltomateHR"
  wb.created = new Date(0)

  // Add sheets in DISPLAY order — ExcelJS orders tabs by add order and
  // there's no post-hoc reorder API. Adjustments must open first when
  // the admin double-clicks the file.

  // ── Adjustments sheet ─────────────────────────────────────────────
  const sheet = wb.addWorksheet("Adjustments", {
    views: [{ state: "frozen", ySplit: 1 }],
  })

  // ── Categories reference sheet ────────────────────────────────────
  const ref = wb.addWorksheet("Categories", {
    views: [{ state: "frozen", ySplit: 1 }],
  })

  ref.columns = [
    { header: "Category label", key: "label", width: 44 },
    { header: "Kind", key: "kind", width: 14 },
    { header: "Group", key: "group", width: 32 },
    { header: "EPF", key: "epf", width: 6 },
    { header: "SOCSO", key: "socso", width: 8 },
    { header: "EIS", key: "eis", width: 6 },
    { header: "PCB", key: "pcb", width: 6 },
    { header: "HRDF", key: "hrdf", width: 7 },
    { header: "Tax-exempt limit (RM/yr)", key: "taxExempt", width: 22 },
    { header: "Notes", key: "notes", width: 60 },
  ]

  // Header row styling.
  const refHeader = ref.getRow(1)
  refHeader.font = { bold: true }
  refHeader.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEAFC" },
  }
  refHeader.alignment = { vertical: "middle" }

  // Categories sorted by label to match the dropdown's visual order.
  const categoriesSorted = Object.values(PAYROLL_ADJUSTMENT_CATEGORY_META)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))

  for (const meta of categoriesSorted) {
    ref.addRow([
      meta.label,
      kindLabel(meta.kind),
      meta.group,
      yn(meta.subjectToEpf),
      yn(meta.subjectToSocso),
      yn(meta.subjectToEis),
      yn(meta.subjectToPcb),
      yn(meta.subjectToHrdf),
      meta.taxExemptLimit != null
        ? Number(meta.taxExemptLimit).toLocaleString("en-MY", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : "—",
      buildBehaviourNotes(meta),
    ])
  }

  // Colour Y / N cells so admins can scan the grid quickly.
  for (let r = 2; r <= categoriesSorted.length + 1; r++) {
    for (const col of [4, 5, 6, 7, 8]) {
      const cell = ref.getRow(r).getCell(col)
      const raw = cell.value
      if (raw === "Y") {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE7F5EA" },
        }
        cell.font = { color: { argb: "FF116329" }, bold: true }
      } else if (raw === "N") {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF6F6F6" },
        }
        cell.font = { color: { argb: "FF8A8A8A" } }
      }
      cell.alignment = { horizontal: "center", vertical: "middle" }
    }
  }
  ref.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 10 },
  }

  // Named range on column A (the labels) — used by the Adjustments
  // sheet's Category dropdown validation.
  const lastCatRow = categoriesSorted.length + 1
  wb.definedNames.add(`Categories!$A$2:$A$${lastCatRow}`, "CategoryList")

  // ── Populate Adjustments sheet ───────────────────────────────────
  sheet.columns = [
    { header: "Full Name", key: "name", width: 30 },
    { header: "Category", key: "category", width: 40 },
    { header: "Label", key: "label", width: 32 },
    { header: "Amount", key: "amount", width: 14 },
  ]

  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEAFC" },
  }
  headerRow.alignment = { vertical: "middle" }

  // Note on the Full Name header explaining multi-line semantics.
  sheet.getCell("A1").note = {
    texts: [
      {
        text:
          `Bulk-adjustment template for the ${input.periodLabel} payroll run.\n\n` +
          `Uploading this file REPLACES every existing one-off adjustment on the run.\n\n` +
          `Multiple adjustments per employee — just add another row with the same Full Name. ` +
          `E.g. one row for bonus, another row for loan repayment.\n\n` +
          `Category column has a dropdown — see the "Categories" tab for what each option is subject to.`,
      },
    ],
  }

  // Seed rows. Pre-fill Full Name for every eligible employee so the
  // admin doesn't have to retype. Category/Label/Amount stay blank so
  // an unedited upload writes nothing (all rows fail row-level
  // validation and the file is rejected cleanly).
  const rows =
    input.employees.length > 0
      ? input.employees.map((e) => [e.name, "", "", ""])
      : [
          [
            "Ali bin Ahmad",
            "Standard Allowance",
            "January transport top-up",
            250.0,
          ],
        ]

  for (const r of rows) sheet.addRow(r)

  // Amount column: currency format.
  sheet.getColumn(4).numFmt = "#,##0.00"

  // ── Data validation on Category column ───────────────────────────
  // Apply to every seed row + a generous buffer (500 rows) so admins
  // can duplicate rows freely without losing the dropdown. The
  // formula points to the named range built above.
  const dropdownLastRow = Math.max(rows.length + 1, 500)
  for (let r = 2; r <= dropdownLastRow; r++) {
    sheet.getCell(`B${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ["=CategoryList"],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Unknown category",
      error:
        "Pick a value from the dropdown. See the Categories sheet for the full list.",
      showInputMessage: true,
      promptTitle: "Category",
      prompt: "Pick one from the dropdown.",
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 4 },
  }

  const arrayBuffer = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer as ArrayBuffer)
}

// ─── Helpers ────────────────────────────────────────────────────────

function yn(b: boolean): "Y" | "N" {
  return b ? "Y" : "N"
}

function kindLabel(k: PayrollAdjustmentCategoryMeta["kind"]): string {
  switch (k) {
    case "ALLOWANCE":
      return "Allowance"
    case "DEDUCTION":
      return "Deduction"
    case "REIMBURSEMENT":
      return "Reimbursement"
  }
}

/**
 * Compact note summarising the special behaviours of the category —
 * additional-remuneration bonus math, non-cash BIK, zakat offset, TP1
 * relief, etc. Empty when nothing special applies.
 */
function buildBehaviourNotes(meta: PayrollAdjustmentCategoryMeta): string {
  const bits: string[] = []
  if (meta.isAdditionalRemuneration) {
    bits.push(
      "AR — one-off (not projected forward for annual chargeable income)",
    )
  }
  if (meta.nonCash) {
    bits.push(
      "Non-cash BIK — no effect on gross / net pay, but counts toward PCB base",
    )
  }
  if (meta.offsetsPcb) {
    bits.push("Offsets PCB (up to that month's PCB amount)")
  }
  if (meta.cashNeutral) {
    bits.push("Cash-neutral — offsets PCB only, take-home unchanged")
  }
  if (meta.feedsLp1Relief) {
    bits.push("Feeds LP1 relief (lowers annual chargeable income)")
  }
  if (meta.addsToCp38Field) {
    bits.push("Reported in CP39 CP38 field")
  }
  if (meta.reducesGross) {
    bits.push("Reduces displayed Gross (not just take-home)")
  }
  if (meta.reducesBase) {
    bits.push("Reduces statutory wage base for later lines")
  }
  if (meta.taxExemptLimit != null) {
    bits.push(
      `Tax-exempt up to RM ${Number(meta.taxExemptLimit).toLocaleString("en-MY")}/year (excess is PCB-taxable)`,
    )
  }
  return bits.join(" · ")
}
