import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { generateAttendancePdfBulk } from "@/modules/attendance/application/services/attendance-pdf.service"

export async function GET(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return NextResponse.json({ error: "No active organization." }, { status: 400 })

  const url = new URL(request.url)
  const fromStr = url.searchParams.get("from")
  const toStr = url.searchParams.get("to")

  if (!fromStr || !toStr) {
    return NextResponse.json({ error: "Missing required params: from, to" }, { status: 400 })
  }

  const from = new Date(fromStr + "T00:00:00Z")
  const to = new Date(toStr + "T23:59:59Z")
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return NextResponse.json({ error: "Invalid date range." }, { status: 400 })
  }

  const employeeIdsParam = url.searchParams.get("employeeIds")
  const userIds = employeeIdsParam ? employeeIdsParam.split(",").filter(Boolean) : undefined

  try {
    const buffer = await generateAttendancePdfBulk(orgId, from, to, userIds)
    const filename = `attendance-report-all-${fromStr}-to-${toStr}.pdf`
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
