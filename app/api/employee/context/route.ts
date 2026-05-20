import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { isEmployeePortalRole } from "@/lib/auth/types"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { countPendingClaimsForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"
import { countPendingApprovalsForReviewer as countPendingLeaveApprovalsForReviewer } from "@/modules/leave/application/services/leave-application.service"

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

  const [pendingApprovals, pendingClaimApprovals, pendingLeaveApprovals] =
    session.role === "SUPERVISOR"
      ? await Promise.all([
          supervisorAttendanceService.countPendingApprovalsForSupervisor(session.userId),
          countPendingClaimsForSupervisor(session.email),
          countPendingLeaveApprovalsForReviewer(session.userId),
        ])
      : [0, 0, 0]

  return NextResponse.json(
    {
      organizationName: session.organizationName ?? null,
      pendingApprovals,
      pendingClaimApprovals,
      pendingLeaveApprovals,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}
