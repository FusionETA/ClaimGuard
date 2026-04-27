import { redirect } from "next/navigation"

import { AdminHierarchyTable } from "@/components/admin/admin-hierarchy-table"
import { getCurrentSession } from "@/lib/auth/session"
import { getOrganizationHierarchy } from "@/modules/organization/application/services/organization-admin.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export default async function AdminHierarchyPage() {
  const session = await getCurrentSession()
  const members = await getOrganizationHierarchy()
  if (!session || members === null) redirect("/login")

  const [projects, xeroConnections] = await Promise.all([
    session.organizationId
      ? organizationRepository.getProjectsForOrganization(session.organizationId)
      : Promise.resolve([]),
    session.organizationId
      ? organizationRepository.getXeroConnections(session.organizationId)
      : Promise.resolve([]),
  ])

  return (
    <AdminHierarchyTable
      members={members}
      projects={projects}
      xeroConnections={xeroConnections}
    />
  )
}
