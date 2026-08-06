import { NextRequest, NextResponse } from "next/server"

import { resolveEmployeeReportAccess } from "@/modules/attendance/application/services/report-access.service"
import { generateLeaveSummaryPdf } from "@/modules/leave/application/services/leave-pdf.service"

/**
 * GET /api/leave/export/summary?employeeId=&year=YYYY
 *
 * Per-employee leave summary PDF, with the same access rule as the
 * attendance report (see `resolveEmployeeReportAccess`):
 *   - admin/owner → any employee in the active org,
 *   - supervisor  → their team members (+ themselves),
 *   - employee    → themselves only.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const employeeId = url.searchParams.get("employeeId")
  const yearStr = url.searchParams.get("year")

  if (!employeeId || !yearStr) {
    return NextResponse.json(
      { error: "Missing required params: employeeId, year" },
      { status: 400 },
    )
  }

  const access = await resolveEmployeeReportAccess(employeeId)
  if (!access.ok) {
    return NextResponse.json({ error: access.message }, { status: access.status })
  }

  const year = parseInt(yearStr, 10)
  if (isNaN(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Invalid year." }, { status: 400 })
  }

  try {
    const buffer = await generateLeaveSummaryPdf(access.orgId, employeeId, year)
    const filename = `leave-summary-${year}.pdf`
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
