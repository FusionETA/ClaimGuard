import { NextResponse } from "next/server"

import { exportPayrollEmployeesXlsx } from "@/modules/payroll/application/services/payroll-employee-export.service"

/**
 * GET /admin/payroll/employees/export
 *
 * Streams a styled XLSX of every employee in the active org, shaped
 * exactly like the bulk-import template (same header labels, order, and
 * design) so it re-imports cleanly. Admin-gated inside the service
 * (session + role check).
 */
export async function GET() {
  try {
    const { buffer, filename } = await exportPayrollEmployeesXlsx()
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not export employees."
    // Auth failures and missing-org land here; surface as 403 so the
    // browser doesn't download an error page as a .xlsx.
    return NextResponse.json({ error: message }, { status: 403 })
  }
}
