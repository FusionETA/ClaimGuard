import { redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"
import { getAdminAppraisalDashboardData } from "@/modules/appraisify/application/services/appraisal-page-data.service"

import { AdminAppraisalsClient } from "./admin-appraisals-client"

// The admin group layout already enforces the ADMIN role (accepts OWNER);
// this page only needs a session-existence check (matches other admin pages).
export default async function AdminAppraisalsPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  const data = await getAdminAppraisalDashboardData()
  if (!data) redirect("/login")
  return <AdminAppraisalsClient data={data} />
}
