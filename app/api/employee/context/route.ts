import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { isEmployeePortalRole } from "@/lib/auth/types"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export async function GET() {
  const session = await getCurrentSession()

  if (!session || !isEmployeePortalRole(session.role)) {
    return NextResponse.json(
      { message: "Unauthorized." },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    )
  }

  const pendingApprovals =
    session.role === "SUPERVISOR"
      ? await supervisorAttendanceService.countPendingApprovalsForSupervisor(
          session.userId,
        )
      : 0

  return NextResponse.json(
    {
      organizationName: session.organizationName ?? null,
      pendingApprovals,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}
