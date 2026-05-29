import { redirect } from "next/navigation"

import { LeaveBalancesGrid } from "@/components/leave/leave-balances-grid"
import { getCurrentSession } from "@/lib/auth/session"
import { isEmployeePortalRole } from "@/lib/auth/types"
import { listTeamBalancesForSupervisor } from "@/modules/leave/application/services/leave-entitlements.service"

/**
 * /employee/leave/team
 *
 * Supervisor-scoped read-only view of leave balances for the supervisor's
 * direct reports (anyone whose approval chain includes them). When the
 * caller has no direct reports the grid renders an explanatory empty
 * state rather than 403-ing — the page is harmless and the nav link is
 * already gated on supervisor role.
 */
export default async function SupervisorTeamLeaveBalancesPage() {
  const session = await getCurrentSession()
  if (!session || !isEmployeePortalRole(session.role)) redirect("/login")

  const year = new Date().getUTCFullYear()
  const employees = await listTeamBalancesForSupervisor(session.userId, year)

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Leave
        </p>
        <h1 className="font-headline text-2xl font-black text-foreground">
          Team balances
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Leave balances for your direct reports — anyone whose leave
          approval chain you&apos;re on — for {year}.
        </p>
      </div>

      <LeaveBalancesGrid
        employees={employees}
        year={year}
        emptyHint="You don't appear on anyone's approval chain yet. Ask an admin to add you as a leave approver for an employee."
      />
    </div>
  )
}
