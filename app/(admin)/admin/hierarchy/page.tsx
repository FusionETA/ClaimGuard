import { redirect } from "next/navigation"

import { AdminHierarchyTable } from "@/components/admin/admin-hierarchy-table"
import { getCurrentSession } from "@/lib/auth/session"
import { getOrganizationHierarchy } from "@/modules/organization/application/services/organization-admin.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export default async function AdminHierarchyPage() {
  const session = await getCurrentSession()
  const members = await getOrganizationHierarchy()
  if (!session || members === null) redirect("/login")

  const organizationId = session.activeOrganizationId ?? session.organizationId

  const [organization, projects, xeroConnections] = await Promise.all([
    organizationId
      ? organizationRepository.getOrganizationById(organizationId)
      : Promise.resolve(null),
    organizationId
      ? organizationRepository.getProjectsForOrganization(organizationId)
      : Promise.resolve([]),
    organizationId
      ? organizationRepository.getXeroConnections(organizationId)
      : Promise.resolve([]),
  ])

  return (
    <AdminHierarchyTable
      members={members}
      projects={projects}
      xeroConnections={xeroConnections}
      organizationName={organization?.name ?? ""}
    />
  )
}
