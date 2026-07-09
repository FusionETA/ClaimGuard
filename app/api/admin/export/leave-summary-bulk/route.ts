import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { generateLeaveSummaryPdfBulk } from "@/modules/leave/application/services/leave-pdf.service"

export async function GET(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return NextResponse.json({ error: "No active organization." }, { status: 400 })

  const url = new URL(request.url)
  const yearStr = url.searchParams.get("year") ?? String(new Date().getUTCFullYear())
  const year = parseInt(yearStr, 10)
  if (isNaN(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Invalid year." }, { status: 400 })
  }

  const employeeIdsParam = url.searchParams.get("employeeIds")
  const userIds = employeeIdsParam ? employeeIdsParam.split(",").filter(Boolean) : undefined

  try {
    const buffer = await generateLeaveSummaryPdfBulk(orgId, year, userIds)
    const filename = `leave-summary-all-${year}.pdf`
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
