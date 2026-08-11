import { NextResponse } from "next/server"

import { buildEmployeeWorkbookBuffer } from "@/modules/payroll/application/services/report-renderers/employee-workbook"

/**
 * GET /admin/payroll/employees/import-template
 *
 * Streams the styled XLSX template for bulk employee imports: a "Read
 * Me" sheet, a blank "Employees" sheet (friendly header labels, colour-
 * coded by group, `*`-required markers, dropdown validation), and a
 * filled "Example" sheet. Shares its design + column order with the
 * employee export, so an export re-imports cleanly.
 */
export async function GET() {
  const buffer = await buildEmployeeWorkbookBuffer({ mode: "template" })
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="payroll-employee-import-template.xlsx"',
      "Cache-Control": "no-store",
    },
  })
}
