import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import type {
  PayrollCompanyInfoData,
  PayrollSettingsData,
} from "@/modules/payroll/domain/settings"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"

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
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, settings, companyInfo] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollSettingsRepository.getByOrgId(orgId),
    payrollCompanyInfoRepository.getByOrgId(orgId),
  ])

  return {
    organizationName: org?.name ?? "",
    settings,
    companyInfo,
  }
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
