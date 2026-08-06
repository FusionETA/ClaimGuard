import { NextRequest, NextResponse } from "next/server"

import { resolveTeamReportAccess } from "@/modules/attendance/application/services/report-access.service"
import { generateLeaveSummaryPdfBulk } from "@/modules/leave/application/services/leave-pdf.service"

/**
 * GET /api/leave/export/team-summary?year=YYYY
 *
 * ONE leave summary PDF covering the caller's whole team (see
 * `resolveTeamReportAccess`): supervisor → their team members, admin/owner →
 * the whole org.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const yearStr = url.searchParams.get("year")

  if (!yearStr) {
    return NextResponse.json(
      { error: "Missing required param: year" },
      { status: 400 },
    )
  }

  const access = await resolveTeamReportAccess()
  if (!access.ok) {
    return NextResponse.json({ error: access.message }, { status: access.status })
  }

  const year = parseInt(yearStr, 10)
  if (isNaN(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Invalid year." }, { status: 400 })
  }

  try {
    const buffer = await generateLeaveSummaryPdfBulk(
      access.orgId,
      year,
      access.userIds ?? undefined,
    )
    const filename = `team-leave-summary-${year}.pdf`
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
