import { notFound, redirect } from "next/navigation"

import { requirePortalSession } from "@/lib/auth/session"
import { getAppraisalFormData } from "@/modules/appraisify/application/services/appraisal-page-data.service"
import { confirmPhaseParam } from "@/modules/appraisify/domain/models"

import { NotReadyBanner } from "../_ui"
import { AppraisalFormClient } from "./appraisal-form-client"

export default async function AppraisalFormPage({
  params,
}: {
  params: Promise<{ appraisalId: string }>
}) {
  await requirePortalSession("EMPLOYEE")
  const { appraisalId } = await params

  const data = await getAppraisalFormData(appraisalId)
  if (!data) notFound()

  const { record, phase, access } = data

  // Already submitted → funnel to the confirmation screen.
  if (access === "submitted") {
    redirect(`/employee/appraisals/${record.id}/confirm?phase=${confirmPhaseParam(phase)}`)
  }

  // Earlier phase not done yet → amber "not ready" banner (reviewer/partner only).
  if (access === "not-ready" && phase !== "reviewee") {
    return <NotReadyBanner phase={phase} />
  }

  return <AppraisalFormClient record={record} phase={phase} />
}
