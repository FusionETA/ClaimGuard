import { redirect } from "next/navigation"

import { AdminClaimsQueue } from "@/components/claims/admin-claims-queue"
import { getCurrentSession } from "@/lib/auth/session"
import { listClaimsForSupervisorReview } from "@/modules/claims/application/services/claim-workflow.service"

export default async function SupervisorReviewPage() {
  const session = await getCurrentSession()

  if (!session) redirect("/login")
  if (session.role !== "SUPERVISOR") redirect("/employee")

  const claims = await listClaimsForSupervisorReview({ session })

  return <AdminClaimsQueue claims={claims} />
}
