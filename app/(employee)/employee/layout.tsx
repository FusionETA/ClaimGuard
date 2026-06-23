import { EmployeeShell } from "@/components/layout/employee-shell"
import { requirePortalSession } from "@/lib/auth/session"
import { deriveOrgEnabledModulesFromRow } from "@/modules/organization/domain/plan"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
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
  const policyAccess = policy
    ? moduleAccessForPolicy(policy)
    : DEFAULT_MODULE_ACCESS

  // AND with the org's plan-enabled modules. A DIY-Free org doesn't
  // surface Claims / Attendance to anyone, even employees whose
  // policy would normally allow it. Legacy orgs (no plan recorded)
  // return null → no intersection, existing tenants keep their full
  // nav.
  const orgPlanRow = session.organizationId
    ? await organizationRepository.getOrgPlanModules(session.organizationId)
    : null
  const orgEnabledModules = orgPlanRow
    ? deriveOrgEnabledModulesFromRow(orgPlanRow)
    : null

  const orgSet = orgEnabledModules ? new Set<string>(orgEnabledModules) : null
  const moduleAccess = orgSet
    ? {
        attendance: policyAccess.attendance && orgSet.has("attendance"),
        // Either claims module being enabled is enough for the employee
        // nav (it's a single "Claims" tab on their side).
        claims:
          policyAccess.claims &&
          (orgSet.has("claims_personal") || orgSet.has("claims_company")),
        leave: policyAccess.leave && orgSet.has("leave"),
      }
    : policyAccess

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
