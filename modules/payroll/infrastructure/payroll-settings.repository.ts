import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type { PayrollSettingsData } from "@/modules/payroll/domain/settings"

/**
 * Per-org `PayrollSettings` (OT rates, working-days rule, EPF defaults,
 * HRDF, employer ID). 1:1 with Organization — upsert by organizationId.
 *
 * When no row exists, `getByOrgId` returns null and the UI shows the
 * Prisma defaults baked into the schema. First save creates the row.
 */
export const payrollSettingsRepository = {
  async getByOrgId(organizationId: string): Promise<PayrollSettingsData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollSettings.findUnique({
      where: { organizationId },
    })
    if (!row) return null
    return mapPayrollSettings(row)
  },

  async upsert(input: {
    organizationId: string
    patch: Partial<Omit<PayrollSettingsData, "id" | "organizationId" | "createdAt" | "updatedAt">>
  }): Promise<PayrollSettingsData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const data = toUpsertData(input.patch)

    const row = await prisma.payrollSettings.upsert({
      where: { organizationId: input.organizationId },
      create: { organizationId: input.organizationId, ...data },
      update: data,
    })

    return mapPayrollSettings(row)
  },
}

function mapPayrollSettings(row: any): PayrollSettingsData {
  return {
    id: row.id,
    organizationId: row.organizationId,
    otRateNormal: toNumber(row.otRateNormal, 1.5),
    otRateRest: toNumber(row.otRateRest, 2),
    otRatePublicHoliday: toNumber(row.otRatePublicHoliday, 3),
    workingDaysRule: row.workingDaysRule,
    defaultEpfEmployeeRate: toNumber(row.defaultEpfEmployeeRate, 11),
    defaultEpfEmployerRate: toNumber(row.defaultEpfEmployerRate, 13),
    hrdfEnabled: row.hrdfEnabled,
    hrdfRate: row.hrdfRate === null ? null : toNumber(row.hrdfRate, 0),
    employerIdNumber: row.employerIdNumber ?? null,
    myCoOrSsmNumber: row.myCoOrSsmNumber ?? null,
    leaveCarryForwardAllowed: row.leaveCarryForwardAllowed,
    leaveCarryForwardLimitDays: row.leaveCarryForwardLimitDays ?? null,
    leaveCarryForwardExpiryMonths: row.leaveCarryForwardExpiryMonths ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toUpsertData(
  patch: Partial<Omit<PayrollSettingsData, "id" | "organizationId" | "createdAt" | "updatedAt">>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const copy = <K extends keyof typeof patch>(k: K) => {
    if (patch[k] !== undefined) out[k as string] = patch[k]
  }
  copy("otRateNormal")
  copy("otRateRest")
  copy("otRatePublicHoliday")
  copy("workingDaysRule")
  copy("defaultEpfEmployeeRate")
  copy("defaultEpfEmployerRate")
  copy("hrdfEnabled")
  copy("hrdfRate")
  copy("employerIdNumber")
  copy("myCoOrSsmNumber")
  copy("leaveCarryForwardAllowed")
  copy("leaveCarryForwardLimitDays")
  copy("leaveCarryForwardExpiryMonths")
  return out
}
