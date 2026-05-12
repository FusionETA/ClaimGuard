import { EmployeeShell } from "@/components/layout/employee-shell"
import { requirePortalSession } from "@/lib/auth/session"
import {
  DEFAULT_MODULE_ACCESS,
  moduleAccessForPolicy,
} from "@/modules/policy/domain/models"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const policy = await policyRepository.findForUserId(session.userId)
  const moduleAccess = policy
    ? moduleAccessForPolicy(policy)
    : DEFAULT_MODULE_ACCESS

  return (
    <EmployeeShell
      user={session}
      organizationName={session.organizationName}
      moduleAccess={moduleAccess}
    >
      {children}
    </EmployeeShell>
  )
}
