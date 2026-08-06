import { redirect } from "next/navigation"

import { ExecutiveOverview } from "@/components/admin/executive-overview"
import { OnLeaveTodayCard } from "@/components/admin/leave/on-leave-today-card"
import { QuickActionsCard } from "@/components/admin/quick-actions-card"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getAdminExecutiveOverview } from "@/modules/claims/application/services/admin-executive-overview.service"
import { getAdminQuickActionCounts } from "@/modules/claims/application/services/admin-quick-actions.service"
import { getActiveAdminAccessModules } from "@/modules/organization/application/services/admin-access.service"
import { getOnLeaveTodayForOrg } from "@/modules/leave/application/services/leave-overview.service"

export default async function AdminOverviewPage() {
  const session = await getCurrentSession()
  const orgId = session ? resolveActiveOrgId(session) : undefined

  const [overview, onLeaveToday, quickActionCounts, accessModules] =
    await Promise.all([
      getAdminExecutiveOverview(),
      orgId ? getOnLeaveTodayForOrg(orgId) : Promise.resolve(null),
      getAdminQuickActionCounts(),
      getActiveAdminAccessModules(),
    ])
  if (!overview) redirect("/login")

  return (
    <div className="space-y-6">
      <QuickActionsCard
        counts={quickActionCounts}
        accessModules={accessModules}
      />
      <ExecutiveOverview data={overview} />
      {/* `null` means the org has no leave types yet — module isn't in
          use, so we hide the card entirely. */}
      {onLeaveToday !== null && <OnLeaveTodayCard entries={onLeaveToday} />}
    </div>
  )
}
