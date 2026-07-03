import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getOrSetCache } from "@/lib/cache"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import type {
  PayrollCompanyInfoData,
  PayrollSettingsData,
} from "@/modules/payroll/domain/settings"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"

/**
 * HRD Corp tier per PSMB Act 2001 First Schedule (as amended 2021).
 *
 * Thresholds enforced here (per the admin's product spec — slightly
 * more conservative than a strict reading of the Act):
 *
 *   - PART_I    — MORE THAN 10 active Malaysian-citizen employees
 *                 → MANDATORY 1.0% (auto-enable, cannot be turned off)
 *   - PART_II   — 5 to 10 active Malaysian-citizen employees
 *                 → OPTIONAL 0.5% (admin decides; the "decide zone")
 *   - NOT_APPLICABLE — fewer than 5 → no HRDF, force-disabled
 *
 * PSMB Act § 2 defines "employee" as a citizen of Malaysia, so PRs and
 * foreign workers are excluded from the count. Archived profiles are
 * also excluded — only *active* employees count toward the threshold,
 * so an archive can drop the org out of Part I back into the
 * decide-zone next month.
 *
 * Note vs strict Act reading: the Act's First Schedule text reads
 * "10 or more", i.e. ≥10 = mandatory. This system uses `> 10` so an
 * org sitting exactly at 10 stays in the decide zone (admin choice
 * respected), only auto-enabling on the eleventh Malaysian citizen.
 */
export type HrdfTier = "PART_I" | "PART_II" | "NOT_APPLICABLE"

/**
 * Combined service for the settings page. Loads both tables in one
 * shot (Promise.all) so the tabbed UI renders with a single fetch.
 *
 * Mutation actions delegate to whichever repo is relevant; each tab's
 * action writes only its own table.
 */

export type PayrollSettingsPageData = {
  organizationName: string
  settings: PayrollSettingsData | null
  companyInfo: PayrollCompanyInfoData | null
  /// Number of active (non-archived) Malaysian-citizen employees in
  /// the org. Drives the HRDF tier display in the settings form.
  malaysianEmployeeCount: number
  hrdfTier: HrdfTier
  /// True when the org has at least one Xero connection. Read live so
  /// OAuth connect/update status cannot lag behind Redis page data.
  hasXeroConnection: boolean
}

type PayrollSettingsCachedPageData = Omit<
  PayrollSettingsPageData,
  "hasXeroConnection"
>

export async function getPayrollSettingsPageData(): Promise<PayrollSettingsPageData | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 1-hour TTL — settings/company-info change rarely; each mutation
  // calls `bustPayrollCaches({ organizationId })` so the next render is
  // always fresh. Xero connection state stays outside this cache because
  // OAuth scope/status changes must show immediately after callback.
  const [cached, xeroConnections] = await Promise.all([
    getOrSetCache(
      key("org", orgId, "payroll", "page", "settings"),
      3600,
      () => loadPayrollSettingsPageData(orgId),
    ),
    organizationRepository.getXeroConnections(orgId),
  ])
  return cached
    ? { ...cached, hasXeroConnection: xeroConnections.length > 0 }
    : null
}

async function loadPayrollSettingsPageData(
  orgId: string,
): Promise<PayrollSettingsCachedPageData | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, settings, companyInfo, malaysianEmployeeCount] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollSettingsRepository.getByOrgId(orgId),
    payrollCompanyInfoRepository.getByOrgId(orgId),
    countActiveMalaysianEmployees(prisma, orgId),
  ])

  return {
    organizationName: org?.name ?? "",
    settings,
    companyInfo,
    malaysianEmployeeCount,
    hrdfTier: hrdfTierFromCount(malaysianEmployeeCount),
  }
}

/**
 * Count active (non-archived) employees in the org whose
 * `PayrollProfile.nationality` is recognized as Malaysian by
 * `isMalaysianNationality` (the same helper the calc engine uses).
 * Employees without a payroll profile yet are excluded — they don't
 * count toward the HRDF threshold until onboarded.
 */
async function countActiveMalaysianEmployees(
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>,
  organizationId: string,
): Promise<number> {
  const users = await prisma.user.findMany({
    where: {
      organizationId,
      role: { in: ["EMPLOYEE", "SUPERVISOR"] },
      employeeProfiles: { some: { organizationId } },
    },
    select: {
      employeeProfiles: {
        where: { organizationId },
        select: {
          payrollProfile: {
            select: {
              nationality: true,
              isArchived: true,
            },
          },
        },
        take: 1,
      },
    },
  })

  let count = 0
  for (const u of users) {
    const pp = u.employeeProfiles[0]?.payrollProfile
    if (!pp) continue
    if (pp.isArchived) continue
    if (isMalaysianNationality(pp.nationality)) count++
  }
  return count
}

/**
 * Public: resolve the HRDF tier from an active Malaysian-citizen head-
 * count. Kept `export` so `payroll-run.service` can enforce the same
 * rule at run time (payroll must not silently skip HRDF when the org
 * has crossed the mandatory threshold, even if the DB's cached
 * `hrdfEnabled` flag is stale from before the last hire).
 *
 * See the HrdfTier doc block above for the thresholds + rationale.
 */
export function hrdfTierFromCount(count: number): HrdfTier {
  if (count > 10) return "PART_I"
  if (count >= 5) return "PART_II"
  return "NOT_APPLICABLE"
}

/**
 * Public counterpart to the private helper above. Used by
 * `payroll-run.service` when the run engine needs a fresh count
 * (rather than trusting the possibly-stale DB `hrdfEnabled` flag).
 */
export async function countActiveMalaysianEmployeesForOrg(
  organizationId: string,
): Promise<number> {
  const prisma = getPrismaClient()
  if (!prisma) return 0
  return countActiveMalaysianEmployees(prisma, organizationId)
}

export async function upsertPayrollSettings(
  patch: Parameters<typeof payrollSettingsRepository.upsert>[0]["patch"],
): Promise<PayrollSettingsData> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const result = await payrollSettingsRepository.upsert({
    organizationId: orgId,
    patch,
  })
  await bustPayrollCaches({ organizationId: orgId })
  return result
}

/**
 * Fetch the COA list + tracking categories for the active org's Xero
 * connection. Surfaced in the settings UI as dropdown options.
 *
 * Returns `null` when:
 *   - the admin's session has no active org, OR
 *   - the org has no Xero connection, OR
 *   - the Xero token can't be refreshed (admin must reconnect).
 *
 * The caller (settings page / action) shows a friendly empty state in
 * those cases — no exception bubbles up.
 */
export async function getXeroMappingOptions(): Promise<{
  accounts: Array<{ id: string; code: string; name: string; type?: string }>
  trackingCategories: Array<{
    id: string
    name: string
    options: Array<{ id: string; name: string }>
  }>
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 5-min TTL; busted by bustPayrollCaches on settings/mapping saves +
  // Xero sync. Also spares a token refresh + live Xero tracking-category
  // call on every Settings → Xero visit. Tradeoff: a transient Xero
  // timeout can cache an empty category list until the TTL/next bust.
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "xero-mapping-options"),
    300,
    () => loadXeroMappingOptions(orgId),
  )
}

async function loadXeroMappingOptions(orgId: string): Promise<{
  accounts: Array<{ id: string; code: string; name: string; type?: string }>
  trackingCategories: Array<{
    id: string
    name: string
    options: Array<{ id: string; name: string }>
  }>
} | null> {
  const connections = await organizationRepository.getXeroConnections(orgId)
  const connection = connections[0]
  if (!connection) return null

  // Accounts come from our LOCAL ChartOfAccount table (already synced
  // from Xero). Instant — no Xero API call, no auth dance, no spinner.
  // Tracking categories still come from Xero live; they're a small
  // list (~1–5 categories) and we don't currently cache them.
  const localAccounts =
    await organizationRepository.getXeroLinkedChartAccountsForOrganization(orgId)

  // Mapper for the local-accounts result — used in both the success
  // and the degraded path so we don't repeat the sort/projection.
  const projectAccounts = () =>
    localAccounts
      .map((a) => ({
        id: a.xeroAccountId,
        code: a.code,
        name: a.name,
        type: a.type ?? undefined,
      }))
      .sort((a, b) => a.code.localeCompare(b.code))

  // Lazy-import the heavier Xero helpers so the settings service stays
  // cheap to load when Xero isn't configured.
  const { getUsableXeroAccessToken } = await import(
    "@/modules/organization/application/services/xero-connection.service"
  )
  const { getXeroTrackingCategories } = await import("@/lib/xero")

  // If token refresh fails / times out, we still render the page with
  // local accounts — the tracking-category picker just shows an empty
  // list. Better than hanging on "Loading…" forever.
  const token = await getUsableXeroAccessToken(connection.id).catch(() => null)
  if (!token) {
    return { accounts: projectAccounts(), trackingCategories: [] }
  }

  try {
    // Race the Xero call against a 5-second timeout. If Xero is slow
    // or unreachable we still return the page with accounts loaded.
    const trackingCategories = await Promise.race<
      Awaited<ReturnType<typeof getXeroTrackingCategories>> | null
    >([
      getXeroTrackingCategories({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ])
    if (!trackingCategories) {
      // Timed out — render the settings page anyway. Admin can save
      // accounts now and pick the tracking category later.
      console.warn(
        "[payroll-settings] tracking category fetch timed out after 5s",
      )
      return { accounts: projectAccounts(), trackingCategories: [] }
    }
    return {
      accounts: projectAccounts(),
      trackingCategories: trackingCategories.map((cat) => ({
        id: cat.xeroTrackingCategoryId,
        name: cat.name,
        options: cat.options.map((o) => ({
          id: o.xeroTrackingOptionId,
          name: o.name,
        })),
      })),
    }
  } catch (err) {
    // Don't fail the whole page if the tracking-category fetch
    // throws. Return what we have so the admin can still see /
    // configure the COA dropdowns; the tracking-category picker
    // just shows an empty list.
    console.error("[payroll-settings] tracking category fetch failed:", err)
    return { accounts: projectAccounts(), trackingCategories: [] }
  }
}

export async function upsertPayrollCompanyInfo(
  patch: Parameters<typeof payrollCompanyInfoRepository.upsert>[0]["patch"],
): Promise<PayrollCompanyInfoData> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const result = await payrollCompanyInfoRepository.upsert({
    organizationId: orgId,
    patch,
  })
  await bustPayrollCaches({ organizationId: orgId })
  return result
}
