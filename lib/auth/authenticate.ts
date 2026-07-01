import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { verifyPassword } from "@/lib/auth/password"
import { getPrimaryEmployeeProfile } from "@/lib/auth/employee-profile"
import type {
  SessionUser,
} from "@/lib/auth/types"
import { isAdminRole } from "@/lib/auth/types"
import { buildInitials } from "@/lib/utils"
import { employeeOrganizationRepository } from "@/modules/organization/infrastructure/employee-organization.repository"

function buildSubtitle(
  role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "OWNER",
  profile: { jobTitle: string } | null
) {
  if (role === "OWNER") {
    return "Owner"
  }

  if (role === "ADMIN") {
    return "Administrator"
  }

  if (role === "SUPERVISOR") {
    return profile?.jobTitle ?? "Supervisor"
  }

  return profile?.jobTitle ?? "Employee"
}

export async function authenticateUser({
  email,
  password,
}: {
  email: string
  password: string
}) {
  const normalizedEmail = email.trim().toLowerCase()
  const prisma = getPrismaClient()

  if (!prisma) {
    return {
      success: false as const,
      message: "Database is not configured. Contact your administrator.",
    }
  }

  // Email is no longer DB-unique — pick the ACTIVE row for this email
  // (non-archived PayrollProfile, or no PayrollProfile at all for
  // admins). Archived rows reject login at this gate; their password
  // hash on a stale row should never grant access.
  const user = await prisma.user.findFirst({
    where: {
      email: normalizedEmail,
      OR: [
        { employeeProfiles: { none: {} } },
        {
          employeeProfiles: {
            some: {
              OR: [
                { payrollProfile: null },
                { payrollProfile: { isArchived: false } },
              ],
            },
          },
        },
      ],
    },
    include: { employeeProfiles: true, organization: true },
  })

  if (!user) {
    return {
      success: false as const,
      message: "Invalid email or password.",
    }
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return {
      success: false as const,
      message: "Invalid email or password.",
    }
  }

  // Multi-org employee resolution: read the active EmployeeOrganization
  // memberships to decide which org the session should land on.
  //
  //   0 memberships → pure admin (or edge-case user with no employee
  //     profile at all). Fall back to `User.organizationId` — same as
  //     pre-rollout behaviour.
  //   1 membership  → auto-select that org.
  //   2+ memberships → leave `activeOrganizationId` UNDEFINED. The
  //     login-form redirect logic (Phase 3) will detect the missing
  //     active org and route to /employee/pick-company.
  //
  // Admin sessions still use `User.organizationId` as the initial
  // active org; AdminOrganization is their multi-org switch mechanism
  // (already implemented via the header org-switcher for admins).
  let activeOrganizationId: string | undefined
  if (isAdminRole(user.role)) {
    activeOrganizationId = user.organizationId ?? undefined
  } else {
    const memberships =
      await employeeOrganizationRepository.listActiveMembershipsForUser(
        prisma,
        user.id,
      )
    if (memberships.length === 1) {
      activeOrganizationId = memberships[0]!.organizationId
    } else if (memberships.length === 0) {
      activeOrganizationId = user.organizationId ?? undefined
    }
    // else 2+ → leave undefined, picker will fill it.
  }

  // Pre-populate the active Xero connection so every downstream query that
  // reads session.activeXeroConnectionId can trust it without re-resolving.
  // Picks the first connection on the resolved active org at login time.
  let activeXeroConnectionId: string | undefined
  if (activeOrganizationId) {
    const firstConnection = await prisma.xeroConnection.findFirst({
      where: { organizationId: activeOrganizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    activeXeroConnectionId = firstConnection?.id ?? undefined
  }

  const primaryProfile = getPrimaryEmployeeProfile(user.employeeProfiles)
  return {
    success: true as const,
    user: {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      initials: buildInitials(user.name),
      subtitle: buildSubtitle(user.role, primaryProfile),
      organizationId: user.organizationId ?? undefined,
      organizationName: user.organization?.name ?? undefined,
      activeOrganizationId,
      activeXeroConnectionId,
    } satisfies SessionUser,
  }
}

/**
 * Build a SessionUser for an ALREADY-TRUSTED email — i.e. after a verified
 * SSO hand-off where the identity has been proven by a signed token, so no
 * password check happens here. Restricted to admin-tier accounts
 * (ADMIN / OWNER): SSO into AltomateHR is an admin-portal entry point, and
 * we never want a token to mint a session for an arbitrary employee row.
 *
 * When `targetOrganizationId` is supplied, the session's
 * `activeOrganizationId` is set to that org rather than the user's
 * primary `User.organizationId`. The caller (the SSO callback) verifies
 * the email has admin access to that org BEFORE calling this — when the
 * id reaches us here it's already trusted. We defensively skip the
 * override (and fall back to primary) if the org doesn't exist, so an
 * orphaned target id never produces a broken session.
 */
export async function buildSessionUserForEmail(
  email: string,
  options: {
    targetOrganizationId?: string
  } = {},
): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "no-db" | "not-found" | "not-admin" }
> {
  const normalizedEmail = email.trim().toLowerCase()
  const prisma = getPrismaClient()
  if (!prisma) return { ok: false, reason: "no-db" }

  // Admin SSO entry — pick the ACTIVE row only. Same active-user
  // filter as the password login path above; archived rows aren't
  // valid landing accounts.
  const user = await prisma.user.findFirst({
    where: {
      email: normalizedEmail,
      OR: [
        { employeeProfiles: { none: {} } },
        {
          employeeProfiles: {
            some: {
              OR: [
                { payrollProfile: null },
                { payrollProfile: { isArchived: false } },
              ],
            },
          },
        },
      ],
    },
    include: { employeeProfiles: true, organization: true },
  })
  if (!user) return { ok: false, reason: "not-found" }
  if (!isAdminRole(user.role)) return { ok: false, reason: "not-admin" }

  // Decide which org the session should LAND on. Default = the user's
  // primary org (`User.organizationId`). When SSO supplies a target,
  // we use that — but only after a sanity check that the org row exists
  // (the AdminOrganization-membership check happens at the SSO callback,
  // before this function runs).
  let activeOrganizationId: string | undefined = user.organizationId ?? undefined
  if (options.targetOrganizationId) {
    const target = await prisma.organization.findUnique({
      where: { id: options.targetOrganizationId },
      select: { id: true },
    })
    if (target) activeOrganizationId = target.id
  }

  // Pin the first Xero connection of the LANDING org (not the primary
  // org) so the admin-portal Xero context lines up with the org they're
  // about to see — otherwise they'd land in Org B but see Org A's Xero
  // tenant in the connection picker.
  let activeXeroConnectionId: string | undefined
  if (activeOrganizationId) {
    const firstConnection = await prisma.xeroConnection.findFirst({
      where: { organizationId: activeOrganizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    activeXeroConnectionId = firstConnection?.id ?? undefined
  }

  const ssoPrimaryProfile = getPrimaryEmployeeProfile(user.employeeProfiles)
  return {
    ok: true,
    user: {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      initials: buildInitials(user.name),
      subtitle: buildSubtitle(user.role, ssoPrimaryProfile),
      organizationId: user.organizationId ?? undefined,
      organizationName: user.organization?.name ?? undefined,
      activeOrganizationId,
      activeXeroConnectionId,
      // This builder is SSO-only (only caller is /api/sso/altomate
      // — password login goes through verifyCredentials above). The
      // shells use this flag to hide the Log out button, since SSO
      // customers should sign out from Altomate Accounting (the
      // parent system) instead of landing on our /login.
      loggedInViaSso: true,
    } satisfies SessionUser,
  }
}
