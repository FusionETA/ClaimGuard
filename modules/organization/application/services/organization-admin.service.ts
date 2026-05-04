import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import type { OrganizationMember } from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export async function getOrganizationHierarchy(): Promise<OrganizationMember[] | null> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return null
  }

  const organizationId = resolveActiveOrgId(session)

  if (!organizationId) {
    return []
  }

  return organizationRepository.getOrganizationMembers(
    organizationId,
    session.activeXeroConnectionId
  )
}
