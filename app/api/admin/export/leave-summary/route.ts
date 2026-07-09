import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { generateLeaveSummaryPdf } from "@/modules/leave/application/services/leave-pdf.service"

export async function GET(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return NextResponse.json({ error: "No active organization." }, { status: 400 })

  const url = new URL(request.url)
  const employeeId = url.searchParams.get("employeeId")
  const yearStr = url.searchParams.get("year")

  if (!employeeId || !yearStr) {
    return NextResponse.json({ error: "Missing required params: employeeId, year" }, { status: 400 })
  }

  const year = parseInt(yearStr, 10)
  if (isNaN(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Invalid year." }, { status: 400 })
  }

  try {
    const buffer = await generateLeaveSummaryPdf(orgId, employeeId, year)
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
