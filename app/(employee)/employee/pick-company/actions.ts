"use server"

import type { Route } from "next"
import { redirect } from "next/navigation"

import { getCurrentSession, updateCurrentSession } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { getPrismaClient } from "@/lib/prisma"
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
  if (!orgId) redirect("/employee/pick-company" as Route)

  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (isAdminRole(session.role)) redirect("/admin")

  const prisma = getPrismaClient()
  if (!prisma) redirect("/login")

  // Validate membership BEFORE writing the session cookie — otherwise
  // a client could POST an arbitrary orgId and gain access.
  const membership = await employeeOrganizationRepository.getMembership(
    prisma,
    session.userId,
    orgId,
  )
  if (!membership) {
    // Not a real membership for this user — send them back to the
    // picker to see their actual options.
    redirect("/employee/pick-company" as Route)
  }
  if (membership.isArchived === true) {
    // Archived at this org — shouldn't have shown in the picker, but
    // guard defensively.
    redirect("/employee/pick-company" as Route)
  }

  await updateCurrentSession({ activeOrganizationId: orgId })
  redirect("/employee")
}
