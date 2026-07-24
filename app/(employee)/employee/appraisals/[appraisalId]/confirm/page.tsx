import { requirePortalSession } from "@/lib/auth/session"
import { getAppraisalConfirmationData } from "@/modules/appraisify/application/services/appraisal-page-data.service"

import { ConfirmationScreen, type ConfirmPhase } from "../../_confirmation"

const VALID: ConfirmPhase[] = ["self", "reviewer", "partner"]

export default async function AppraisalConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ appraisalId: string }>
  searchParams: Promise<{ phase?: string }>
}) {
  await requirePortalSession("EMPLOYEE")
  const { appraisalId } = await params
  const { phase } = await searchParams

  const p: ConfirmPhase = VALID.includes(phase as ConfirmPhase) ? (phase as ConfirmPhase) : "self"
  const data = await getAppraisalConfirmationData(appraisalId)

  return <ConfirmationScreen phase={p} referenceNumber={data?.referenceNumber} />
}
