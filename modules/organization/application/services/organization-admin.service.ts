import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
import type { OrganizationMember } from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export async function getOrganizationHierarchy(): Promise<OrganizationMember[] | null> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
    return null
  }

  const organizationId = resolveActiveOrgId(session)

  if (!organizationId) {
    return []
  }

  // Per-admin policy scope: owners + legacy admins get `null` (no
  // filter); restricted admins only see employees on their granted
  // policies. The repo accepts the same `policyIdScope` shape as the
  // claims repo so the call site stays uniform.
  const policyIdScope = await getActiveAdminPolicyScope()

  // Filter the hierarchy by the active organisation only — NOT by the
  // session's activeXeroConnectionId. The company picker (Org dropdown
  // in the admin header) is the single source of truth for which
  // employees an admin sees, so non-Xero orgs and employees imported
  // without a Xero connection both show correctly. The repo's
  // xeroConnectionId arg is still supported for any caller that
  // explicitly wants the narrower filter.
  return organizationRepository.getOrganizationMembers(organizationId, {
    policyIdScope,
  })
}
