import { NextResponse } from "next/server"

import { exportPayrollEmployeesCsv } from "@/modules/payroll/application/services/payroll-employee-export.service"

/**
 * GET /admin/payroll/employees/export
 *
 * Streams a CSV of every employee in the active org, shaped exactly
 * like the bulk-import template so it re-imports cleanly. Admin-gated
 * inside the service (session + role check).
 */
export async function GET() {
  try {
    const { csv, filename } = await exportPayrollEmployeesCsv()
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not export employees."
    // Auth failures and missing-org land here; surface as 403 so the
    // browser doesn't download an error page as a .csv.
    return NextResponse.json({ error: message }, { status: 403 })
  }
}
