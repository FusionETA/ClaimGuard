import { redirect } from "next/navigation"
import { CircleDollarSign, Clock3, Files, Wallet } from "lucide-react"

import { MetricCard } from "@/components/claims/metric-card"
import { getAdminDashboard } from "@/modules/claims/application/services/admin-portal.service"
import { formatCurrency } from "@/lib/utils"

export default async function AdminOverviewPage() {
  const data = await getAdminDashboard()
  if (!data) redirect("/login")

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard title="Total claims" value={String(data.totals.totalClaims)} icon={Files} detail="All time" compact />
      <MetricCard title="Needs review" value={String(data.totals.pending)} icon={Clock3} detail="Supervisor queue" compact />
      <MetricCard title="Approved value" value={formatCurrency(data.totals.approvedValue)} icon={CircleDollarSign} detail="Approved + paid" compact />
      <MetricCard title="Paid value" value={formatCurrency(data.totals.paidValue)} icon={Wallet} detail="Completed payouts" compact />
    </div>
  )
}
