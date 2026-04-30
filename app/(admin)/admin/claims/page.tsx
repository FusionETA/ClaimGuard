import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { CircleDollarSign, Clock3, Files, Wallet } from "lucide-react"

import { AdminClaimsTable } from "@/components/admin/admin-claims-table"
import { MetricCard } from "@/components/claims/metric-card"
import {
  getAdminClaimsQueue,
  getAdminDashboard,
} from "@/modules/claims/application/services/admin-portal.service"
import { getXeroConnectionSummary } from "@/modules/organization/application/services/xero-connection.service"
import { getCurrentSession } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { formatCurrency } from "@/lib/utils"

const ACTIVE_CONNECTION_COOKIE = "claimguard_active_connection"

export default async function AdminClaimsPage() {
  const [session, claims, data] = await Promise.all([
    getCurrentSession(),
    getAdminClaimsQueue(),
    getAdminDashboard(),
  ])
  if (!claims || !data || !session) redirect("/login")

  const organizationId = session.activeOrganizationId ?? session.organizationId

  // Resolve active Xero connection: session > cookie > first connection for org.
  // Mirrors the logic in app/(admin)/admin/settings/page.tsx so the bank-account
  // query stays scoped to the connection the admin is actually working in.
  const cookieStore = await cookies()
  const cookieConnectionId = cookieStore.get(ACTIVE_CONNECTION_COOKIE)?.value
  const xeroConnection = await getXeroConnectionSummary(organizationId)
  let activeXeroConnectionId =
    session.activeXeroConnectionId ??
    cookieConnectionId ??
    xeroConnection.connections[0]?.id ??
    undefined
  if (
    activeXeroConnectionId &&
    !xeroConnection.connections.find((c) => c.id === activeXeroConnectionId)
  ) {
    activeXeroConnectionId = xeroConnection.connections[0]?.id ?? undefined
  }

  const bankAccounts = organizationId
    ? await organizationRepository.getBankAccountsForOrganization({
        organizationId,
        xeroConnectionId: activeXeroConnectionId,
      })
    : []

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Total claims"
          value={String(data.totals.totalClaims)}
          icon={Files}
          detail="All time"
          compact
        />
        <MetricCard
          title="Needs review"
          value={String(data.totals.pending)}
          icon={Clock3}
          detail="Supervisor queue"
          compact
        />
        <MetricCard
          title="Approved value"
          value={formatCurrency(data.totals.approvedValue)}
          icon={CircleDollarSign}
          detail="Approved + paid"
          compact
        />
        <MetricCard
          title="Paid value"
          value={formatCurrency(data.totals.paidValue)}
          icon={Wallet}
          detail="Completed payouts"
          compact
        />
      </div>

      <AdminClaimsTable claims={claims} bankAccounts={bankAccounts} />
    </div>
  )
}
