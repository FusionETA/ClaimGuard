import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { AdminClaimsTable } from "@/components/admin/admin-claims-table"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getAdminClaimsPageData } from "@/modules/claims/application/services/admin-page-data.service"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

const ACTIVE_CONNECTION_COOKIE = "claimguard_active_connection"

export default async function AdminClaimsPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  await requireAdminModule(["claims_personal", "claims_company"])

  const cookieStore = await cookies()
  const cookieConnectionId = cookieStore.get(ACTIVE_CONNECTION_COOKIE)?.value
  const preferredConnectionId =
    session.activeXeroConnectionId ?? cookieConnectionId ?? undefined

  const data = await getAdminClaimsPageData({
    organizationId: resolveActiveOrgId(session),
    preferredConnectionId,
  })
  if (!data) redirect("/login")

  const { dashboard, claims, chartAccounts } = data

  return (
    <div className="space-y-6">
      <AdminClaimsTable
        claims={claims}
        chartAccounts={chartAccounts}
        metrics={{
          totalClaims: dashboard.totals.totalClaims,
          needsReview: dashboard.totals.pending,
          approvedValue: dashboard.totals.approvedValue,
        }}
      />
    </div>
  )
}
