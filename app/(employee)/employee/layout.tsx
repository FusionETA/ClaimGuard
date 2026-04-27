import { EmployeeShell } from "@/components/layout/employee-shell"
import { requirePortalSession } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const profile = await claimRepository.getEmployeeWithProfile(session.email)

  // Prefer the Xero tenant name the employee is assigned to; fall back to org name
  const displayOrg = profile?.xeroConnectionName ?? profile?.organizationName

  return (
    <EmployeeShell user={session} organizationName={displayOrg}>
      {children}
    </EmployeeShell>
  )
}
