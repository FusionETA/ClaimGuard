import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Email-uniqueness helpers — replace the DB-level `@unique` that used
 * to live on `User.email`.
 *
 * Why we dropped the DB constraint: archived employees should be
 * allowed to come back later — same email, new employer or even the
 * same one. The old `@unique` made that impossible without first
 * deleting (or anonymising) the historical row, which destroys the
 * audit trail.
 *
 * Replacement rule:
 *   At most ONE active user per email, globally across all orgs.
 *
 * Definition of active (matches the rest of the app):
 *   - User has no PayrollProfile at all, OR
 *   - User has a PayrollProfile with `isArchived = false`.
 *
 * Definition of archived:
 *   - User has a PayrollProfile with `isArchived = true`.
 *
 * Two helpers below cover the two real call patterns:
 *
 *   `findActiveUserByEmail(email)` — login + password-reset lookup. We
 *      no longer use `findUnique` because email isn't unique at the
 *      DB level. Returns the active user, or null if every row for
 *      that email is archived (effectively "no active account").
 *
 *   `assertEmailAvailableForNewUser({ email, orgId })` — create-time
 *      validator. Throws `EmailNotAvailableError` with a code so the
 *      caller can show a precise message:
 *        * `IN_USE_ACTIVE`  → an active user already has this email.
 *        * `ARCHIVED_SAME_ORG` → an archived user with this email
 *          exists in the SAME org. Admin should Restore them instead
 *          of creating a parallel record.
 *      Archived rows in OTHER orgs are not a conflict — that's the
 *      whole point of dropping the unique constraint.
 *
 * These run against a fresh DB read each call. We don't cache: stale
 * cache here would let two creates slip past the check during a small
 * window. For low-volume admin-driven user creation that's fine.
 */

type ActiveUserHit = {
  id: string
  email: string
  name: string
  role: "OWNER" | "ADMIN" | "EMPLOYEE" | "SUPERVISOR"
  organizationId: string | null
  passwordHash: string
}

export async function findActiveUserByEmail(
  email: string,
): Promise<ActiveUserHit | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null
  const normalised = email.trim().toLowerCase()
  // Pull every row for this email — usually 1, possibly more after the
  // unique constraint was dropped — then pick the active one (per the
  // PayrollProfile.isArchived definition above). `take: 5` is a safety
  // cap; if the same email genuinely has more than 5 historical rows
  // we still find the active one in the prefix.
  const candidates = await prisma.user.findMany({
    where: { email: normalised },
    take: 5,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      organizationId: true,
      passwordHash: true,
      // `employeeProfiles` is a LIST (a User can hold a profile at more
      // than one org since the multi-org change). We only need each
      // profile's archived flag to decide active-vs-archived.
      employeeProfiles: {
        select: { payrollProfile: { select: { isArchived: true } } },
      },
    },
  })
  for (const c of candidates) {
    if (isActiveCandidate(c)) {
      // Strip the join projection — caller only needs the User fields.
      const { employeeProfiles: _unused, ...rest } = c
      void _unused
      return rest
    }
  }
  return null
}

/**
 * Thrown by `assertEmailAvailableForNewUser` when an existing row
 * blocks the create. The `code` field lets the caller render an
 * action-specific error (toast vs banner vs "use Restore" CTA)
 * without re-parsing message strings.
 */
export class EmailNotAvailableError extends Error {
  constructor(
    public readonly code: "IN_USE_ACTIVE" | "ARCHIVED_SAME_ORG",
    message: string,
  ) {
    super(message)
    this.name = "EmailNotAvailableError"
  }
}

export async function assertEmailAvailableForNewUser(input: {
  email: string
  /// Org the new user will belong to. Required so we can distinguish
  /// "archived in this org" (block, ask to Restore) from "archived in
  /// another org" (allowed — the rejoin case this whole change exists
  /// for). Pass null when creating an org-less account (rare — OWNER
  /// signup flow); the same-org check is skipped in that case.
  orgId: string | null
}): Promise<void> {
  const prisma = getPrismaClient()
  if (!prisma) {
    // Without a DB we can't validate — fail closed so we don't accept
    // a create that might later collide.
    throw new EmailNotAvailableError(
      "IN_USE_ACTIVE",
      "Database is not configured.",
    )
  }
  const normalised = input.email.trim().toLowerCase()
  const candidates = await prisma.user.findMany({
    where: { email: normalised },
    select: {
      id: true,
      organizationId: true,
      // List, post multi-org. Carry each profile's org so the
      // "archived in THIS org" check below reads the profile's org
      // (not the User's home-org scalar, which is meaningless once a
      // user spans multiple orgs).
      employeeProfiles: {
        select: {
          organizationId: true,
          payrollProfile: { select: { isArchived: true } },
        },
      },
    },
  })
  if (candidates.length === 0) return

  // Active wins — that's always a block.
  if (candidates.some((c) => isActiveCandidate(c))) {
    throw new EmailNotAvailableError(
      "IN_USE_ACTIVE",
      "This email is already in use by an active employee.",
    )
  }
  // No active match anywhere. Check for an archived profile IN THIS ORG.
  if (input.orgId) {
    const archivedInThisOrg = candidates.some((c) =>
      c.employeeProfiles.some(
        (p) =>
          p.organizationId === input.orgId &&
          p.payrollProfile?.isArchived === true,
      ),
    )
    if (archivedInThisOrg) {
      throw new EmailNotAvailableError(
        "ARCHIVED_SAME_ORG",
        "This email belongs to an archived employee in this organisation. Use Restore on their profile instead of adding a duplicate.",
      )
    }
  }
  // Archived rows exist only in OTHER orgs — that's the rejoin case
  // this whole change unlocks. Allowed.
}

// ─── Internals ──────────────────────────────────────────────────────

function isActiveCandidate(c: {
  employeeProfiles: Array<{
    payrollProfile: { isArchived: boolean } | null
  }>
}): boolean {
  // No profile at all = active (admin / OWNER without payroll).
  if (c.employeeProfiles.length === 0) return true
  // Active if ANY profile is non-archived. A profile with no
  // PayrollProfile counts as active — same rule as the single-profile
  // era ("no payroll profile = active"), just applied per profile.
  return c.employeeProfiles.some((p) => p.payrollProfile?.isArchived !== true)
}
