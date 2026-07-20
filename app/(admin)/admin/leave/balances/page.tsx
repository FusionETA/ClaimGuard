import { Suspense } from "react"
import { redirect } from "next/navigation"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

import { BalancesGridLoader } from "./balances-grid-loader"

function GridSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-16 w-full animate-pulse rounded-2xl bg-muted" />
      ))}
    </div>
  )
}

export default async function AdminLeaveBalancesPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  await requireAdminModule("leave")
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) redirect("/admin/settings")

  const year = new Date().getUTCFullYear()

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Leave
        </p>
        <h1 className="font-headline text-2xl font-black text-foreground">
          Employee balances
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Current leave balances across every active employee in this company for {year}. To
          adjust an individual entitlement, use{" "}
          <span className="font-semibold">Leave → Settings</span>.
        </p>
      </div>

      <Suspense fallback={<GridSkeleton />}>
        <BalancesGridLoader organizationId={organizationId} year={year} />
      </Suspense>
    </div>
  )
}
