import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
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

export async function getPayrollSettingsPageData(): Promise<{
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
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

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

  return payrollSettingsRepository.upsert({ organizationId: orgId, patch })
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

  // Lazy-import the heavier Xero + connection helpers so the settings
  // service module stays cheap to load when Xero isn't configured.
  const { getUsableXeroAccessToken } = await import(
    "@/modules/organization/application/services/xero-connection.service"
  )
  const { getXeroAccounts, getXeroTrackingCategories } = await import(
    "@/lib/xero"
  )

  const token = await getUsableXeroAccessToken(connection.id)
  if (!token) return null

  try {
    const [accounts, trackingCategories] = await Promise.all([
      getXeroAccounts({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
        includeTypes: ["EXPENSE", "LIABILITY", "CURRLIAB", "TERMLIAB"],
      }),
      getXeroTrackingCategories({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      }),
    ])
    return {
      accounts: accounts
        .map((a) => ({
          id: a.xeroAccountId,
          code: a.code,
          name: a.name,
          type: a.type,
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
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
    // Don't fail the whole page if Xero is down — return null and the
    // UI shows a "Xero unreachable" message.
    console.error("[payroll-settings] Xero mapping options fetch failed:", err)
    return null
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

  return payrollCompanyInfoRepository.upsert({ organizationId: orgId, patch })
}
