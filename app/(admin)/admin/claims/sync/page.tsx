import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Sparkles } from "lucide-react"

import { ClaimSyncList } from "@/components/admin/claim-sync-list"
import { Card, CardContent } from "@/components/ui/card"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const ACTIVE_CONNECTION_COOKIE = "claimguard_active_connection"

/**
 * Admin-only "Ready to sync" page. Shows every claim that's:
 *   - status === REVIEWED (admin-approved)
 *   - xeroSyncStatus === NOT_SYNCED (still awaiting push)
 *
 * Each row exposes a final-stage COA picker + a Sync button. Clicking
 * Sync calls the syncClaimAction stub, which (today) just flips the
 * sync status — the real Xero create-bill / spend-money call is left
 * for a future task. Employees never see this page; their view caps at
 * "Reviewed" regardless of xeroSyncStatus.
 */
export default async function AdminClaimsSyncPage() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">
            Pick or create an organization before syncing claims.
          </p>
        </CardContent>
      </Card>
    )
  }

  const cookieStore = await cookies()
  const cookieConnectionId = cookieStore.get(ACTIVE_CONNECTION_COOKIE)?.value
  const xeroConnectionId =
    session.activeXeroConnectionId ?? cookieConnectionId ?? undefined

  const [claims, chartAccounts] = await Promise.all([
    claimRepository.getClaimsAwaitingSync(organizationId, xeroConnectionId),
    // Pull EVERY selectable account for the active org, not the
    // employee-scoped variant. The latter filters by xeroConnectionId
    // and returns "custom accounts only" (xeroConnectionId IS NULL)
    // when the connection arg is undefined — that wrongly hides Xero-
    // imported accounts from the admin's recode dropdown. The admin
    // here is recoding a reviewed claim before pushing it to Xero, so
    // they need the full selectable list scoped only by org.
    organizationRepository.getSelectableChartAccountsForOrganization(
      organizationId,
    ),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold">Ready to sync</h1>
          <p className="text-sm text-muted-foreground">
            Reviewed claims awaiting their push to Xero. Recode the chart of
            account here if needed — this is the last point you can change it.
          </p>
        </div>
      </div>

      <ClaimSyncList claims={claims} chartAccounts={chartAccounts} />
    </div>
  )
}
