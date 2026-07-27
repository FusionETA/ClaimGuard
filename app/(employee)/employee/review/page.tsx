import { redirect } from "next/navigation"

import { AdminClaimsQueue } from "@/components/claims/admin-claims-queue"
import { ClaimsSubNav } from "@/components/claims/claims-sub-nav"
import { getCurrentSession } from "@/lib/auth/session"
import { listClaimsForSupervisorReview } from "@/modules/claims/application/services/claim-workflow.service"

export default async function SupervisorReviewPage() {
  const session = await getCurrentSession()

  if (!session) redirect("/login")
  if (session.role !== "SUPERVISOR") redirect("/employee")

  const claims = await listClaimsForSupervisorReview({ session })

  return (
    <>
      <ClaimsSubNav role={session.role} />
      <AdminClaimsQueue claims={claims} supervisorId={session.userId} />
    </>
  )
}
