import { redirect } from "next/navigation"

import { AdminHierarchyTable } from "@/components/admin/admin-hierarchy-table"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getAdminHierarchyPageData } from "@/modules/claims/application/services/admin-page-data.service"

export default async function AdminHierarchyPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const data = await getAdminHierarchyPageData({
    organizationId: resolveActiveOrgId(session),
  })
  if (!data) redirect("/login")

  return (
    <AdminHierarchyTable
      members={data.members}
      projects={data.projects}
      xeroConnections={data.xeroConnections}
      organizationName={data.organizationName}
      teams={data.teams}
    />
  )
}
