import { NextRequest, NextResponse } from "next/server"

import { generateTeamAttendancePdf } from "@/modules/attendance/application/services/attendance-pdf.service"
import { resolveTeamReportAccess } from "@/modules/attendance/application/services/report-access.service"

/**
 * GET /api/attendance/export/team-report?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * ONE attendance PDF covering the caller's whole team (see
 * `resolveTeamReportAccess`): supervisor → their team members, admin/owner →
 * the whole org.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const fromStr = url.searchParams.get("from")
  const toStr = url.searchParams.get("to")

  if (!fromStr || !toStr) {
    return NextResponse.json(
      { error: "Missing required params: from, to" },
      { status: 400 },
    )
  }

  const access = await resolveTeamReportAccess()
  if (!access.ok) {
    return NextResponse.json({ error: access.message }, { status: access.status })
  }

  const from = new Date(fromStr + "T00:00:00Z")
  const to = new Date(toStr + "T23:59:59Z")
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return NextResponse.json({ error: "Invalid date range." }, { status: 400 })
  }

  try {
    const buffer = await generateTeamAttendancePdf(
      access.orgId,
      from,
      to,
      access.userIds ?? undefined,
    )
    const filename = `team-attendance-${fromStr}-to-${toStr}.pdf`
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
