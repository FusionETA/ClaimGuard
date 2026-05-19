import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
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
 * HRD Corp tier per PSMB Act 2001 First Schedule (as amended 2021):
 *
 *   - PART_I    — 10+ Malaysian-citizen employees → MANDATORY 1.0%
 *   - PART_II   — 5-9 Malaysian-citizen employees → OPTIONAL 0.5%
 *                 (employer must register voluntarily)
 *   - NOT_APPLICABLE — under 5 Malaysian-citizen employees → no HRDF
 *
 * The count is Malaysian citizens only because PSMB Act § 2 defines
 * "employee" as a citizen of Malaysia (PRs and foreign workers are
 * excluded).
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
  /// True when the org has at least one Xero connection. Used to gate
  /// the "sync claims / payroll to Xero on submit" toggles in the
  /// settings UI — when there's no connection, those toggles are
  /// hidden entirely (and persisted as false).
  hasXeroConnection: boolean
}

export async function getPayrollSettingsPageData(): Promise<PayrollSettingsPageData | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 1-hour TTL — settings/company-info/xeroMapping change rarely; each
  // mutation calls `bustPayrollCaches({ organizationId })` so the next
  // render is always fresh. The TTL is just a backstop.
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "settings"),
    3600,
    () => loadPayrollSettingsPageData(orgId),
  )
}

async function loadPayrollSettingsPageData(
  orgId: string,
): Promise<PayrollSettingsPageData | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, settings, companyInfo, malaysianEmployeeCount, xeroConnections] =
    await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      }),
      payrollSettingsRepository.getByOrgId(orgId),
      payrollCompanyInfoRepository.getByOrgId(orgId),
      countActiveMalaysianEmployees(prisma, orgId),
      organizationRepository.getXeroConnections(orgId),
    ])

  return {
    organizationName: org?.name ?? "",
    settings,
    companyInfo,
    malaysianEmployeeCount,
    hrdfTier: hrdfTierFromCount(malaysianEmployeeCount),
    hasXeroConnection: xeroConnections.length > 0,
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
      employeeProfile: { isNot: null },
    },
    select: {
      employeeProfile: {
        select: {
          payrollProfile: {
            select: {
              nationality: true,
              isArchived: true,
            },
          },
        },
      },
    },
  })

  let count = 0
  for (const u of users) {
    const pp = u.employeeProfile?.payrollProfile
    if (!pp) continue
    if (pp.isArchived) continue
    if (isMalaysianNationality(pp.nationality)) count++
  }
  return count
}

function hrdfTierFromCount(count: number): HrdfTier {
  if (count >= 10) return "PART_I"
  if (count >= 5) return "PART_II"
  return "NOT_APPLICABLE"
}

export async function upsertPayrollSettings(
  patch: Parameters<typeof payrollSettingsRepository.upsert>[0]["patch"],
): Promise<PayrollSettingsData> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
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
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

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
  if (!session || session.role !== "ADMIN") {
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
