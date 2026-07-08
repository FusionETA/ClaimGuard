import { redirect } from "next/navigation"

import { LogoutButton } from "@/components/layout/logout-button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentSession } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { employeeOrganizationRepository } from "@/modules/organization/infrastructure/employee-organization.repository"
import { PickCompanyGrid } from "./pick-company-grid"

/**
 * Company picker page for multi-org employees.
 *
 * When the login flow (or the "Switch Company" button in the employee
 * shell) lands a user here, we present them a card grid of every
 * organisation they hold an active EmployeeOrganization row for.
 * Clicking a card sets `session.activeOrganizationId` and redirects
 * to /employee.
 *
 * Auto-skip cases:
 *   - Session missing / expired → /login
 *   - Session role is admin → /admin (this page is employee-only)
 *   - User has exactly 1 active membership → that org is auto-selected
 *     (via the login flow's single-membership branch); we shouldn't
 *     normally get here, but redirect defensively
 *   - User has 0 active memberships → /login (no active employment)
 *
 * When rendered, the header repeats the "Which company would you like
 * to view?" prompt so an employee returning via the shell's Switch
 * Company button knows what's expected.
 */
export default async function PickCompanyPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (isAdminRole(session.role)) redirect("/admin")

  const memberships =
    await employeeOrganizationRepository.listActiveMembershipsForUser(
      session.userId,
    )
  if (memberships.length === 0) {
    // No active employment (or DB unavailable) — the login flow
    // should have blocked this, but guard defensively so a stale
    // session with revoked memberships doesn't render an empty
    // picker.
    redirect("/login")
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-xl border-border/60 shadow-panel">
        <CardHeader className="space-y-2 pb-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Welcome, {session.name}
          </p>
          <CardTitle className="text-2xl">
            Which company would you like to view?
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            You&apos;re an active employee at{" "}
            <strong>{memberships.length}</strong> companies. Pick one to
            continue — you can switch anytime from the header.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <PickCompanyGrid memberships={memberships} />
          <div className="flex justify-end border-t border-border/50 pt-3">
            <LogoutButton />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
