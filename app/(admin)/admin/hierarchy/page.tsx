import { redirect } from "next/navigation"

import { AdminHierarchyTable } from "@/components/admin/admin-hierarchy-table"
import { getOrganizationHierarchy } from "@/modules/claims/application/services/admin-portal.service"

export default async function AdminHierarchyPage() {
  const members = await getOrganizationHierarchy()
  if (!members) redirect("/login")

  return <AdminHierarchyTable members={members} />
}
