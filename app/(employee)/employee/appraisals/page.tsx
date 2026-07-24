import { redirect } from "next/navigation"

import { requirePortalSession } from "@/lib/auth/session"
import { getEmployeeAppraisalDashboardData } from "@/modules/appraisify/application/services/appraisal-page-data.service"

import { AppraisalsPageClient } from "./appraisals-page-client"

export default async function EmployeeAppraisalsPage() {
  await requirePortalSession("EMPLOYEE")
  const data = await getEmployeeAppraisalDashboardData()
  if (!data) redirect("/login")
  return <AppraisalsPageClient data={data} />
}
