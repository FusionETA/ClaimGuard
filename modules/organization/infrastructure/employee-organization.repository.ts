import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Repository for the EmployeeOrganization join table (introduced in
 * the multi-org employee rollout). Each row links a User to one
 * Organization at the employee-portal level and points at the specific
 * EmployeeProfile for that org.
 *
 * A user can hold multiple memberships (concurrent employment across
 * group companies). The login flow reads this to decide whether to
 * auto-select an active org or route the user to the company picker.
 * The employee shell reads it to decide whether to render the
 * "Switch Company" button.
 *
 * All methods fetch the Prisma client internally (per the
 * infrastructure-layer convention) so callers — including pages,
 * server actions, and lib helpers — don't need to import
 * `@/lib/prisma` themselves, which is restricted to infrastructure
 * modules by the repo-wide eslint rule.
 */

export type EmployeeOrganizationMembership = {
  organizationId: string
  organizationName: string
  employeeProfileId: string
  /// True when the PayrollProfile linked to this EmployeeProfile is
  /// archived. Archived memberships DO NOT show up as active choices
  /// in the picker — an employee archived at Company A + active at
  /// Company B should only see Company B. Null when no PayrollProfile
  /// exists yet (fresh hire, pre-payroll onboarding).
  isArchived: boolean | null
}

export const employeeOrganizationRepository = {
  /**
   * List every EmployeeOrganization row for the given User, joined
   * with the Organization name and the payroll-archive flag. Ordered
   * by createdAt so the user's "primary" (oldest) membership sorts
   * first — used as the deterministic fallback pick when auto-selecting.
   */
  async listMembershipsForUser(
    userId: string,
  ): Promise<EmployeeOrganizationMembership[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employeeOrganization.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        organizationId: true,
        employeeProfileId: true,
        organization: { select: { name: true } },
        employeeProfile: {
          select: {
            payrollProfile: { select: { isArchived: true } },
          },
        },
      },
    })
    return rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      employeeProfileId: row.employeeProfileId,
      isArchived: row.employeeProfile.payrollProfile?.isArchived ?? null,
    }))
  },

  /**
   * Non-archived memberships only. This is what the picker + auto-select
   * flow reads: an employee archived at Company A + active at Company B
   * should NOT see Company A as a choice.
   */
  async listActiveMembershipsForUser(
    userId: string,
  ): Promise<EmployeeOrganizationMembership[]> {
    const all = await this.listMembershipsForUser(userId)
    return all.filter((m) => m.isArchived !== true)
  },

  /**
   * Get the (userId, orgId) membership row if it exists. Used to
   * validate that a session's `activeOrganizationId` is actually one
   * the user is permitted to view — prevents a tampered cookie from
   * granting cross-org access.
   */
  async getMembership(
    userId: string,
    organizationId: string,
  ): Promise<EmployeeOrganizationMembership | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeOrganization.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
      select: {
        organizationId: true,
        employeeProfileId: true,
        organization: { select: { name: true } },
        employeeProfile: {
          select: {
            payrollProfile: { select: { isArchived: true } },
          },
        },
      },
    })
    if (!row) return null
    return {
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      employeeProfileId: row.employeeProfileId,
      isArchived: row.employeeProfile.payrollProfile?.isArchived ?? null,
    }
  },
}
