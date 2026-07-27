import { redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"
import { getAdminTemplatesData } from "@/modules/appraisify/application/services/appraisal-template.service"

import { TemplatesListClient } from "./templates-list-client"

export default async function AdminTemplatesPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  const data = await getAdminTemplatesData()
  if (!data) redirect("/login")
  return <TemplatesListClient templates={data.templates} />
}
