import { redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"
import { getAdminAppraisalDetailData } from "@/modules/appraisify/application/services/appraisal-page-data.service"

import { AdminAppraisalDetailClient } from "./admin-appraisal-detail-client"

// The admin group layout already enforces the ADMIN role (accepts OWNER);
// this page only needs a session-existence check (matches other admin pages).
export default async function AdminAppraisalDetailPage({
  params,
}: {
  params: Promise<{ appraisalId: string }>
}) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  const { appraisalId } = await params

  const record = await getAdminAppraisalDetailData(appraisalId)
  if (!record) redirect("/admin/appraisals")

  return <AdminAppraisalDetailClient record={record} />
}
