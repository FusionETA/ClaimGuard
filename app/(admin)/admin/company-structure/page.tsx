import { redirect } from "next/navigation"

import { AdminCompanyStructure } from "@/components/admin/admin-company-structure"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getAdminCompanyStructurePageData } from "@/modules/claims/application/services/admin-page-data.service"

export default async function AdminCompanyStructurePage() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  const data = await getAdminCompanyStructurePageData({
    organizationId: resolveActiveOrgId(session),
  })
  if (!data) redirect("/login")

  return (
    <AdminCompanyStructure
      organizationName={data.organizationName}
      projects={data.projects}
      teams={data.teams}
    />
  )
}
