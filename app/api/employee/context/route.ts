import { NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isEmployeePortalRole } from "@/lib/auth/types"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { countPendingClaimsForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"
import { countPendingApprovalsForReviewer as countPendingLeaveApprovalsForReviewer } from "@/modules/leave/application/services/leave-application.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

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

  // Multi-org: header org name must reflect the ACTIVE org, not the
  // legacy `session.organizationName` (which is the home org and never
  // updates when the employee switches company). Look it up fresh so
  // the header, page titles, and badges all agree.
  const orgId = resolveActiveOrgId(session)
  const activeOrg = orgId
    ? await organizationRepository.getOrganizationById(orgId)
    : null
  const organizationName =
    activeOrg?.name ?? session.organizationName ?? null

  const [pendingApprovals, pendingClaimApprovals, pendingLeaveApprovals] =
    session.role === "SUPERVISOR"
      ? await Promise.all([
          supervisorAttendanceService.countPendingApprovalsForSupervisor(session.userId),
          countPendingClaimsForSupervisor(session.email, orgId),
          countPendingLeaveApprovalsForReviewer(session.userId),
        ])
      : [0, 0, 0]

  return NextResponse.json(
    {
      organizationName,
      pendingApprovals,
      pendingClaimApprovals,
      pendingLeaveApprovals,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}
