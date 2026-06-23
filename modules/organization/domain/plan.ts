import type { AdminModuleKey } from "@/components/admin/admin-access-picker"

/**
 * Subscription plan → module-access derivation.
 *
 * Authoritative source for "which admin modules does this org have
 * access to, given its current subscription". Used by:
 *
 *   - The /api/v1/admin/organizations endpoint when provisioning a
 *     new org (sets the owner's AdminOrganization.modules to the
 *     derived list so the dashboard nav reflects what they're paying
 *     for from day one).
 *   - The admin + employee layout shells when intersecting their
 *     per-user module set with what the ORG actually enables — an
 *     owner with full-access falls back to "everything the org has
 *     enabled" rather than literally every module in the catalog.
 */

export const ORG_PLANS = ["DIY", "EXPERT"] as const
export type OrgPlan = (typeof ORG_PLANS)[number]

export const ORG_PLAN_TIERS = ["FREE", "PAID"] as const
export type OrgPlanTier = (typeof ORG_PLAN_TIERS)[number]

/**
 * Addon keys the partner API accepts. Kept narrow because each addon
 * has a hand-coded mapping to one or more `AdminModuleKey` values —
 * adding a new string here without updating the mapping below is a
 * silent gap.
 */
export const ORG_ADDONS = ["expense_claim", "clock"] as const
export type OrgAddon = (typeof ORG_ADDONS)[number]

/**
 * Modules every org gets regardless of plan / tier / addons. These
 * are the core HR + admin-tool features that nobody pays extra for.
 *
 *   - payroll, leave, hierarchy: core HR.
 *   - company_structure, audit_log, settings: admin tools.
 *
 * Claims (`claims_personal` + `claims_company`) and `attendance` are
 * NOT in the base set — they're gated by addons.
 */
const BASE_MODULES: readonly AdminModuleKey[] = [
  "payroll",
  "leave",
  "hierarchy",
  "company_structure",
  "audit_log",
  "settings",
] as const

/**
 * Per-addon → module list. Single source of truth so the API
 * validation, layout gating, and admin-grant defaults all agree.
 *
 * `expense_claim` → BOTH claims_personal + claims_company because
 *     the addon represents the Claims feature as a whole; the
 *     personal/company split is an internal scoping detail, not a
 *     separately-priced addon.
 * `clock` → attendance.
 */
const ADDON_TO_MODULES: Record<OrgAddon, readonly AdminModuleKey[]> = {
  expense_claim: ["claims_personal", "claims_company"],
  clock: ["attendance"],
}

/**
 * Compute the set of modules this org has enabled.
 *
 *   - DIY + FREE  → base only. Addons IGNORED (free tier never
 *                   unlocks claims / attendance regardless of what
 *                   the payload sends).
 *   - DIY + PAID  → base + every addon's modules.
 *   - EXPERT      → base + every addon's modules. Same module rules
 *                   as DIY Paid; the difference is just billing /
 *                   account-management responsibility.
 *
 * Returns a deduped readonly array in catalog order.
 */
export function deriveOrgEnabledModules(input: {
  plan: OrgPlan
  tier: OrgPlanTier | null
  addons: ReadonlyArray<string>
}): readonly AdminModuleKey[] {
  const out = new Set<AdminModuleKey>(BASE_MODULES)

  if (input.plan === "DIY" && input.tier === "FREE") {
    return Array.from(out)
  }

  // DIY/PAID or EXPERT: honour addons.
  for (const raw of input.addons) {
    const addon = parseAddon(raw)
    if (!addon) continue
    for (const m of ADDON_TO_MODULES[addon]) out.add(m)
  }
  return Array.from(out)
}

/**
 * Narrow an arbitrary string to a known addon key (or null if
 * unrecognised). Use at API boundaries to drop garbage without
 * throwing — the validator above is purely about deriving modules,
 * not about strict schema validation.
 */
export function parseAddon(raw: string): OrgAddon | null {
  const lowered = raw.trim().toLowerCase()
  return (ORG_ADDONS as readonly string[]).includes(lowered)
    ? (lowered as OrgAddon)
    : null
}

/**
 * Same as `deriveOrgEnabledModules` but eats unknown fields safely —
 * used by the layout shells which read Organization.plan/tier/addons
 * straight off a Prisma row whose types are widened. Falls back to
 * a permissive default (every module enabled) when the org's plan
 * data isn't populated yet (legacy orgs from before plan tracking),
 * so existing tenants keep their full nav until they get re-provisioned.
 */
export function deriveOrgEnabledModulesFromRow(input: {
  plan: string | null | undefined
  tier: string | null | undefined
  addons: unknown
}): readonly AdminModuleKey[] | null {
  if (!input.plan) return null // legacy org, no plan recorded → full access
  const plan: OrgPlan =
    input.plan === "EXPERT" ? "EXPERT" : "DIY"
  const tier: OrgPlanTier | null =
    input.tier === "FREE"
      ? "FREE"
      : input.tier === "PAID"
        ? "PAID"
        : null
  const addons = Array.isArray(input.addons)
    ? (input.addons.filter((a): a is string => typeof a === "string"))
    : []
  return deriveOrgEnabledModules({ plan, tier, addons })
}
