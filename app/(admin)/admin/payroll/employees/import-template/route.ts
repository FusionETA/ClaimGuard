import { NextResponse } from "next/server"

import { EMPLOYEE_IMPORT_COLUMNS } from "@/modules/payroll/domain/employee-import-columns"

/**
 * GET /admin/payroll/employees/import-template
 *
 * Streams the canonical CSV template for bulk employee imports.
 * Required columns are prefixed with `*` in the header row so admins
 * can see at a glance which fields are mandatory. Row 2 documents the
 * accepted values; admins fill their data from row 3.
 *
 * Column definitions are shared with the employee EXPORT
 * (`modules/payroll/domain/employee-import-columns.ts`) so an export is
 * always re-importable against this template.
 */
export async function GET() {
  const csv = buildTemplateCsv()
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="payroll-employee-import-template.csv"',
      "Cache-Control": "no-store",
    },
  })
}

function buildTemplateCsv(): string {
  const headerCells = EMPLOYEE_IMPORT_COLUMNS.map((c) =>
    csvField((c.required ? "*" : "") + c.key),
  )
  const commentCells = EMPLOYEE_IMPORT_COLUMNS.map((c) => csvField(c.description))

  const lines: string[] = []
  // Two-row template: header + description. Admins fill data from row 3.
  lines.push(headerCells.join(","))
  lines.push(commentCells.map((c, i) => (i === 0 ? "# " + c : c)).join(","))
  // BOM for Excel UTF-8 friendliness.
  return "﻿" + lines.join("\r\n") + "\r\n"
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
