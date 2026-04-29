import { redirect } from "next/navigation"

import { ExecutiveOverview } from "@/components/admin/executive-overview"
import { getAdminExecutiveOverview } from "@/modules/claims/application/services/admin-executive-overview.service"

export default async function AdminOverviewPage() {
  const overview = await getAdminExecutiveOverview()
  if (!overview) redirect("/login")

  return <ExecutiveOverview data={overview} />
}
