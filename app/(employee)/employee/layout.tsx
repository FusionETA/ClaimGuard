import { EmployeeShell } from "@/components/layout/employee-shell"
import { requirePortalSession } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { deriveOrgEnabledModulesFromRow } from "@/modules/organization/domain/plan"
import { employeeOrganizationRepository } from "@/modules/organization/infrastructure/employee-organization.repository"
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

  // Multi-org employee: count this user's ACTIVE EmployeeOrganization
  // memberships. If >= 2, the shell renders the "Switch Company"
  // header button. We check the count (not just isMulti > 0) so a
  // legacy single-org employee never sees the button.
  const prisma = getPrismaClient()
  let hasMultipleCompanies = false
  if (prisma) {
    const memberships =
      await employeeOrganizationRepository.listActiveMembershipsForUser(
        prisma,
        session.userId,
      )
    hasMultipleCompanies = memberships.length >= 2
  }

  return (
    <EmployeeShell
      user={session}
      organizationName={session.organizationName}
      moduleAccess={moduleAccess}
      hasMultipleCompanies={hasMultipleCompanies}
    >
      {children}
    </EmployeeShell>
  )
}
