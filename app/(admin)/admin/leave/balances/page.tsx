import { redirect } from "next/navigation"

import { Card, CardContent } from "@/components/ui/card"
import { LeaveBalancesGrid } from "@/components/leave/leave-balances-grid"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { listAllEmployeeBalancesForOrg } from "@/modules/leave/application/services/leave-entitlements.service"

/**
 * /admin/leave/balances
 *
 * Org-wide read-only view of every active employee's leave balances for
 * the current calendar year. Companion to the existing applications +
 * audit overview at /admin/leave. Read-only on this page — overrides
 * live on the Settings tab (`/admin/leave/settings`).
 */
export default async function AdminLeaveBalancesPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) redirect("/admin/settings")

  const year = new Date().getUTCFullYear()
  const employees = await listAllEmployeeBalancesForOrg(organizationId, year)

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
          Current leave balances across every active employee in this
          company for {year}. To adjust an individual entitlement, use{" "}
          <span className="font-semibold">Leave → Settings</span>.
        </p>
      </div>

      {employees.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm font-semibold text-foreground">
              No active employees
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add employees in <span className="font-semibold">
                Company/Employee → Manage Employee
              </span>{" "}
              to see balances here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <LeaveBalancesGrid
          employees={employees}
          year={year}
          showSource
        />
      )}
    </div>
  )
}
