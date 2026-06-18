import "server-only"

import { redirect } from "next/navigation"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Admin access-scope service.
 *
 * Looks up the signed-in admin's per-org access scope stored on the
 * `AdminOrganization` row (set from the Owner's "Manage access" dialog).
 * The repo seeds the row with `modules: null, policyIds: null` for
 * legacy admins and for owners — both signal "full access" here.
 *
 * Two helpers — modules and policies are tracked separately because the
 * surfaces that consume them differ:
 *
 *   • Modules → sidebar visibility (admin-shell) + per-page module gates.
 *   • Policies → row-level filtering on every list query that returns
 *     employee-keyed data (claims, leave, attendance, employees).
 *
 * Both return `null` to mean "no filter — show everything", an empty
 * array to mean "this admin has been locked out of any rows" (rare; we
 * still return [] instead of throwing so the UI shows an empty state
 * cleanly), and a non-empty array when scope is restricted.
 */

/// In-memory shape returned by `loadAccessForActive`. Resolved on demand;
/// the per-request session is the cache boundary so concurrent page-data
/// services can share it via Next's RSC dedup.
export type AdminAccessScope = {
  /// Owner / legacy admin: null. Restricted admin: their picked modules.
  modules: string[] | null
  /// Owner / legacy admin: null. Restricted admin: their picked policy ids.
  policyIds: string[] | null
}

/**
 * Resolve the scope for whoever is signed in, for the active org.
 * Returns `null` if there's no signed-in session OR no active org —
 * callers should treat null the same as "no filter" so unauthenticated
 * paths (cron, public API) don't accidentally hide data they shouldn't.
 */
export async function getActiveAdminAccessScope(): Promise<AdminAccessScope | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return null

  // OWNER short-circuits to full access without hitting the join row.
  if (session.role === "OWNER") {
    return { modules: null, policyIds: null }
  }

  const modules = await organizationRepository.getAdminModulesForOrg({
    adminId: session.userId,
    organizationId,
    userRole: session.role,
  })
  const policyIds = await organizationRepository.getAdminPolicyIdsForOrg({
    adminId: session.userId,
    organizationId,
    userRole: session.role,
  })

  return { modules, policyIds }
}

/**
 * Convenience: just the policy filter for the signed-in admin. Returns:
 *   • `null` → no filter (owner, legacy admin, unauthenticated path)
 *   • `string[]` → restrict employee-keyed queries to rows whose
 *     `employeeProfile.policyId` is in this list. Empty array → admin
 *     sees nothing.
 *
 * Use directly in list-service implementations.
 */
export async function getActiveAdminPolicyScope(): Promise<string[] | null> {
  const scope = await getActiveAdminAccessScope()
  return scope?.policyIds ?? null
}

/**
 * Resolve the admin's `claims_personal` / `claims_company` module
 * grants into the `paymentTypes` filter every claim query takes:
 *   - `undefined` → no filter (owner / legacy admin, both granted)
 *   - `["PERSONAL"]` / `["COMPANY"]` / `["PERSONAL","COMPANY"]` →
 *     restrict to those types
 *   - `[]` → admin has neither module; caller should return 0 rows
 *
 * Centralised here so the claim queue, dashboard tiles, and the quick-
 * actions pending-count all interpret the two module flags identically.
 */
export async function getActiveAdminClaimPaymentTypeScope(): Promise<
  Array<"PERSONAL" | "COMPANY"> | undefined
> {
  const [personal, company] = await Promise.all([
    hasAdminModule("claims_personal"),
    hasAdminModule("claims_company"),
  ])
  if (personal && company) return undefined
  const out: Array<"PERSONAL" | "COMPANY"> = []
  if (personal) out.push("PERSONAL")
  if (company) out.push("COMPANY")
  return out
}

/**
 * Convenience: does the signed-in admin have the given module key in
 * their granted set? Returns `true` for owners / legacy admins (whose
 * module list is `null` = full access). Use for read-only UI gates that
 * still want to render the surface but disable mutations — e.g. the
 * "Manage Employee" tab when `hierarchy` is not granted.
 */
export async function hasAdminModule(moduleKey: string): Promise<boolean> {
  const scope = await getActiveAdminAccessScope()
  if (!scope) return true
  if (scope.modules === null) return true
  return scope.modules.includes(moduleKey)
}

/**
 * Page-level gate. Redirects to `/admin` when the signed-in admin lacks
 * the given module(s). Pass an array to require ANY of the keys —
 * mirrors `requiresModules` semantics in the sidebar nav. Call at the
 * top of every server-component page whose URL must not be hand-typed
 * by admins who lost (or never had) access to it.
 *
 * Owners / legacy admins (`modules === null`) always pass.
 */
export async function requireAdminModule(
  moduleKey: string | ReadonlyArray<string>,
): Promise<void> {
  const scope = await getActiveAdminAccessScope()
  if (!scope || scope.modules === null) return
  const required = Array.isArray(moduleKey) ? moduleKey : [moduleKey]
  if (required.length === 0) return
  const granted = new Set(scope.modules)
  if (required.some((m) => granted.has(m))) return
  redirect("/admin")
}

/**
 * Resolve the policy scope into the concrete set of EMPLOYEE USER IDS
 * the signed-in admin is allowed to see. Used by surfaces like the
 * Executive Overview where many independent queries each need the same
 * scope — pre-compute once and pass `restrictToEmployeeIds: string[]`
 * down so each query just adds `WHERE employeeId IN (...)`.
 *
 *   • `null` → no scope (owner / legacy admin); caller skips the filter.
 *   • `string[]` (possibly empty) → restrict to these user ids.
 */
export async function getActiveAdminEmployeeIdScope(
  organizationId: string,
): Promise<string[] | null> {
  const policyIdScope = await getActiveAdminPolicyScope()
  if (policyIdScope === null) return null
  if (policyIdScope.length === 0) return []
  const prisma = (await import("@/lib/prisma")).getPrismaClient()
  if (!prisma) return []
  const rows = await prisma.user.findMany({
    where: {
      organizationId,
      role: { in: ["EMPLOYEE", "SUPERVISOR"] },
      employeeProfile: { policyId: { in: policyIdScope } },
    },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}
