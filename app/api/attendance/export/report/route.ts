import { NextRequest, NextResponse } from "next/server"

import { generateAttendancePdf } from "@/modules/attendance/application/services/attendance-pdf.service"
import { resolveEmployeeReportAccess } from "@/modules/attendance/application/services/report-access.service"

/**
 * GET /api/attendance/export/report?employeeId=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Per-employee attendance PDF, accessible to whoever is allowed to see that
 * employee's report (see `resolveEmployeeReportAccess`):
 *   - admin/owner → any employee in the active org,
 *   - supervisor  → their team members (+ themselves),
 *   - employee    → themselves only.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const employeeId = url.searchParams.get("employeeId")
  const fromStr = url.searchParams.get("from")
  const toStr = url.searchParams.get("to")

  if (!employeeId || !fromStr || !toStr) {
    return NextResponse.json(
      { error: "Missing required params: employeeId, from, to" },
      { status: 400 },
    )
  }

  const access = await resolveEmployeeReportAccess(employeeId)
  if (!access.ok) {
    return NextResponse.json({ error: access.message }, { status: access.status })
  }

  const from = new Date(fromStr + "T00:00:00Z")
  const to = new Date(toStr + "T23:59:59Z")
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return NextResponse.json({ error: "Invalid date range." }, { status: 400 })
  }

  try {
    const buffer = await generateAttendancePdf(access.orgId, employeeId, from, to)
    const filename = `attendance-report-${fromStr}-to-${toStr}.pdf`
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate report."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
