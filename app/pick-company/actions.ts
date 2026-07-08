"use server"

import type { Route } from "next"
import { redirect } from "next/navigation"

import { getCurrentSession, updateCurrentSession } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { employeeOrganizationRepository } from "@/modules/organization/infrastructure/employee-organization.repository"

/**
 * Set the session's activeOrganizationId to the chosen org and
 * redirect to the employee dashboard.
 *
 * Guards:
 *   - No session → /login
 *   - Admin role → /admin (this action is employee-only)
 *   - Chosen orgId is NOT a valid membership for this user → /login
 *     (defence-in-depth against a tampered form submission trying to
 *     grant cross-org access)
 */
export async function selectCompanyAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("organizationId") ?? "").trim()
  if (!orgId) redirect("/pick-company" as Route)

  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (isAdminRole(session.role)) redirect("/admin")

  // Validate membership BEFORE writing the session cookie — otherwise
  // a client could POST an arbitrary orgId and gain access. Repo
  // returns null when the DB is unavailable — same effective outcome
  // as the old getPrismaClient() redirect: the picker rejects the
  // submission.
  const membership = await employeeOrganizationRepository.getMembership(
    session.userId,
    orgId,
  )
  if (!membership) {
    // Not a real membership for this user — send them back to the
    // picker to see their actual options.
    redirect("/pick-company" as Route)
  }
  if (membership.isArchived === true) {
    // Archived at this org — shouldn't have shown in the picker, but
    // guard defensively.
    redirect("/pick-company" as Route)
  }

  await updateCurrentSession({ activeOrganizationId: orgId })
  redirect("/employee")
}

/**
 * Clear the session's activeOrganizationId and route back to the
 * picker. Called by the "Switch Company" button in the employee shell
 * header. The picker page rehydrates the list of active memberships
 * so the user always sees the current option set (a company they were
 * archived from mid-session won't appear).
 */
export async function switchCompanyAction(): Promise<void> {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (isAdminRole(session.role)) redirect("/admin")

  // Clear activeOrganizationId — the picker page's guards then read
  // `session.activeOrganizationId` as undefined and let the user pick
  // again. `updateCurrentSession` merges the patch via object spread,
  // so `undefined` overwrites the current org id.
  await updateCurrentSession({ activeOrganizationId: undefined })
  redirect("/pick-company" as Route)
}
