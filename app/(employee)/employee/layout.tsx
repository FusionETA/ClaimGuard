import { EmployeeShell } from "@/components/layout/employee-shell"
import { requirePortalSession } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const profile = await claimRepository.getEmployeeWithProfile(session.email)

  // Prefer the Xero tenant name the employee is assigned to; fall back to org name
  const displayOrg = profile?.xeroConnectionName ?? profile?.organizationName

  const pendingApprovals =
    session.role === "SUPERVISOR"
      ? await supervisorAttendanceService.countPendingApprovalsForSupervisor(
          session.userId,
        )
      : 0

  return (
    <EmployeeShell
      user={session}
      organizationName={displayOrg}
      pendingApprovals={pendingApprovals}
    >
      {children}
    </EmployeeShell>
  )
}
