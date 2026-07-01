/**
 * Helpers for picking "the current EmployeeProfile" from a User that
 * (after the multi-org rollout) can have N profiles across N orgs.
 *
 * Historical callers assumed `user.employeeProfile` was a singular
 * relation — always defined or always null. Now `user.employeeProfiles`
 * is an array. To keep the migration surface small, this module
 * exposes helpers that mirror the old singular-lookup semantics.
 */

/**
 * Pick the EmployeeProfile whose `organizationId` matches the target
 * org. Returns null if the user has no matching profile. Use this
 * when you have a session/context that already knows which org is
 * being viewed.
 */
export function getEmployeeProfileForOrg<
  T extends { organizationId?: string | null },
>(
  profiles: readonly T[] | null | undefined,
  orgId: string | null | undefined,
): T | null {
  if (!profiles || profiles.length === 0 || !orgId) return null
  return profiles.find((p) => p.organizationId === orgId) ?? null
}

/**
 * Pick the "primary" EmployeeProfile — the one the caller should
 * treat as canonical when no active-org context is available. Picks
 * the FIRST profile in the array. Since backfill guarantees every
 * historical user has exactly one profile, this preserves the
 * pre-multi-org semantics for callers that haven't been migrated
 * to org-aware lookups yet.
 *
 * Do NOT use this when the caller has an active org id — that's a
 * bug waiting to happen. Use `getEmployeeProfileForOrg` instead.
 */
export function getPrimaryEmployeeProfile<T>(
  profiles: readonly T[] | null | undefined,
): T | null {
  if (!profiles || profiles.length === 0) return null
  return profiles[0] ?? null
}

/**
 * True when the user has more than one active employment membership.
 * Drives the "show company picker" branch on login and the "Switch
 * Company" button in the employee shell.
 */
export function hasMultipleEmployeeProfiles<T>(
  profiles: readonly T[] | null | undefined,
): boolean {
  return (profiles?.length ?? 0) > 1
}
