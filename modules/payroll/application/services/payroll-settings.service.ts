import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import type {
  PayrollCompanyInfoData,
  PayrollSettingsData,
} from "@/modules/payroll/domain/settings"
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
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

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
