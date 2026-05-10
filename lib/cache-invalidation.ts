import "server-only"

import { deleteCacheMany } from "@/lib/cache"
import { key } from "@/lib/redis"

/**
 * Centralised cache-bust helpers, one per feature area. Action handlers
 * call these instead of building key patterns inline so the
 * "what to bust when X mutates" map lives in exactly one file. If we
 * later add new cache surfaces (e.g. a per-team summary), we only need
 * to update the relevant helper here — the call sites stay the same.
 *
 * All helpers are no-ops when Redis isn't configured (fallback behavior
 * lives in `lib/cache.ts`).
 */

/**
 * Invalidate every cache key tied to claims for an organisation. Pass
 * `userId` when the mutation is scoped to one user (e.g. employee
 * submits their own claim). Omit it when the mutation could touch any
 * user's claim caches (e.g. admin-side review of an arbitrary claim).
 *
 * Patterns busted:
 *   - org:{orgId}:claims:*                       (admin queue + dashboard)
 *   - org:{orgId}:user:{userId}:claims:*         (per-user history + dashboard)
 *   - org:{orgId}:user:*:claims:*                (when userId omitted)
 */
export async function bustClaimCaches(args: {
  organizationId: string
  userId?: string
}): Promise<void> {
  const patterns = [key("org", args.organizationId, "claims", "*")]
  patterns.push(
    args.userId
      ? key("org", args.organizationId, "user", args.userId, "claims", "*")
      : key("org", args.organizationId, "user", "*", "claims", "*"),
  )
  // Per-user submission-data cache contains spend-limit math derived
  // from the user's recent claims. New/edited claims change those
  // numbers, so we bust this alongside the claim caches.
  patterns.push(
    args.userId
      ? key("org", args.organizationId, "user", args.userId, "config", "claim-submission-data")
      : key("org", args.organizationId, "user", "*", "config", "claim-submission-data"),
  )
  // Executive overview rolls up claims data — claim mutations make
  // those numbers stale, so we sweep it here too.
  patterns.push(key("org", args.organizationId, "exec-overview", "*"))
  await deleteCacheMany(patterns)
}

/**
 * Invalidate attendance caches for an organisation and/or a specific
 * employee. Same shape as `bustClaimCaches`. Working-hours mutations
 * pass `organizationId` only (affects all employees); clock-in/out
 * mutations pass both since only one employee's caches change.
 *
 * Patterns busted:
 *   - org:{orgId}:attendance:*                   (admin overview / rollcall / stats)
 *   - user:{userId}:attendance:*                 (employee dashboard / history)
 */
export async function bustAttendanceCaches(args: {
  organizationId?: string
  employeeUserId?: string
}): Promise<void> {
  const patterns: string[] = []
  if (args.organizationId) {
    patterns.push(key("org", args.organizationId, "attendance", "*"))
    // Executive overview includes attendance health stats; bust it
    // alongside attendance mutations so admin dashboards reflect
    // late/missing/on-leave changes within the cache window.
    patterns.push(key("org", args.organizationId, "exec-overview", "*"))
  }
  if (args.employeeUserId) {
    patterns.push(key("user", args.employeeUserId, "attendance", "*"))
  }
  if (patterns.length === 0) return
  await deleteCacheMany(patterns)
}

/**
 * Invalidate config-style caches for an organisation. "Config" covers:
 *   - admin page-data services (settings, hierarchy, company-structure)
 *   - per-user form helpers (claim-submission-data dropdowns, account)
 *
 * Called from any mutation that changes org-wide settings, projects,
 * teams, chart accounts, employee profiles, or hierarchy. Coarse-
 * grained on purpose — these caches change infrequently and are
 * relatively cheap to repopulate, so a wide bust is cheaper than
 * tracking exact dependencies.
 *
 * Patterns busted:
 *   - org:{orgId}:config:*                       (admin page data + API list endpoints)
 *   - org:{orgId}:user:*:config:*                (every user's form-helper caches in this org)
 */
export async function bustOrgConfigCaches(args: {
  organizationId: string
}): Promise<void> {
  await deleteCacheMany([
    key("org", args.organizationId, "config", "*"),
    key("org", args.organizationId, "user", "*", "config", "*"),
  ])
}
