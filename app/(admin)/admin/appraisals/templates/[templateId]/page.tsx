import { notFound, redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"
import { getTemplateEditorData } from "@/modules/appraisify/application/services/appraisal-template.service"

import { TemplateEditorClient } from "../template-editor-client"

export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ templateId: string }>
}) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  const { templateId } = await params

  if (templateId === "new") {
    return <TemplateEditorClient template={null} />
  }

  const template = await getTemplateEditorData(templateId)
  if (!template) notFound()
  return <TemplateEditorClient template={template} />
}
