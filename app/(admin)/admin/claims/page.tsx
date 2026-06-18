import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { CircleDollarSign, Clock3, Files } from "lucide-react"

import { AdminClaimsTable } from "@/components/admin/admin-claims-table"
import { MetricCard } from "@/components/claims/metric-card"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { formatCurrency } from "@/lib/utils"
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
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          title="Total claims"
          value={String(dashboard.totals.totalClaims)}
          icon={Files}
          detail="All time"
          compact
        />
        <MetricCard
          title="Needs review"
          value={String(dashboard.totals.pending)}
          icon={Clock3}
          detail="Supervisor + admin queue"
          compact
        />
        <MetricCard
          title="Approved value"
          value={formatCurrency(dashboard.totals.approvedValue)}
          icon={CircleDollarSign}
          detail="All approved claims"
          compact
        />
      </div>

      <AdminClaimsTable claims={claims} chartAccounts={chartAccounts} />
    </div>
  )
}
