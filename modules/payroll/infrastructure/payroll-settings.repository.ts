import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import {
  PAYROLL_XERO_ACCOUNT_KEYS,
  xeroAggregationModes,
  xeroLineGroupingModes,
  type PayrollSettingsData,
  type PayrollXeroAccountKey,
  type PayrollXeroMapping,
  type XeroAggregationMode,
  type XeroLineGroupingMode,
} from "@/modules/payroll/domain/settings"

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
    workingDaysRule: row.workingDaysRule,
    defaultEpfEmployeeRate: toNumber(row.defaultEpfEmployeeRate, 11),
    defaultEpfEmployerRate: toNumber(row.defaultEpfEmployerRate, 13),
    hrdfEnabled: row.hrdfEnabled,
    hrdfRate: row.hrdfRate === null ? null : toNumber(row.hrdfRate, 0),
    // Default true when the column didn't exist yet on legacy rows
    // (prisma db push backfills with the schema default, but be
    // defensive in case the row was hand-inserted).
    autoApplySocsoEisRelief: row.autoApplySocsoEisRelief ?? true,
    // ?? false guards legacy rows minted before these columns existed;
    // prisma db push backfills with the schema default, but defensive
    // anyway.
    syncClaimsToXeroOnSubmit: row.syncClaimsToXeroOnSubmit ?? false,
    syncPayrollToXeroOnSubmit: row.syncPayrollToXeroOnSubmit ?? false,
    xeroMapping: parseXeroMapping(row.xeroMapping),
    ecpPayorAccountNo: row.ecpPayorAccountNo ?? null,
    ecpPayorBic: row.ecpPayorBic ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Tolerant loader for the JSON `xeroMapping` blob. Handles both v1
 * (legacy single-allowance shape) and v2 (with allowance/deduction
 * mode + per-category maps). v1 blobs upgrade to v2 in-flight:
 * UNIFIED mode for both allowance and deduction, with empty
 * per-category maps. Unknown / future versions return null so the
 * admin sees the empty state and re-saves.
 */
function parseXeroMapping(value: unknown): PayrollXeroMapping | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  // Accept both v=1 (legacy) and v=2 (current). Anything else is
  // unknown — refuse to load, admin re-saves.
  if (v.v !== 1 && v.v !== 2) return null

  const aggregationModeRaw = v.aggregationMode
  const aggregationMode: XeroAggregationMode =
    typeof aggregationModeRaw === "string" &&
    (xeroAggregationModes as readonly string[]).includes(aggregationModeRaw)
      ? (aggregationModeRaw as XeroAggregationMode)
      : "PER_EMPLOYEE"

  const trackingCategoryId =
    typeof v.trackingCategoryId === "string" ? v.trackingCategoryId : null

  const rawAccounts =
    v.accounts && typeof v.accounts === "object"
      ? (v.accounts as Record<string, unknown>)
      : {}
  const accounts: Partial<Record<PayrollXeroAccountKey, string | null>> = {}
  for (const key of PAYROLL_XERO_ACCOUNT_KEYS) {
    const id = rawAccounts[key]
    if (typeof id === "string" && id.length > 0) {
      accounts[key] = id
    } else if (id === null) {
      accounts[key] = null
    }
    // missing keys stay absent (== unset)
  }

  // v2-only fields. v1 blobs default to UNIFIED mode + empty per-
  // category maps so the admin can flip the toggle without losing
  // the previously-saved unified account.
  const allowanceMode = parseGroupingMode(v.allowanceMode)
  const deductionMode = parseGroupingMode(v.deductionMode)
  const allowanceAccounts = parseCategoryAccounts(v.allowanceAccounts)
  const deductionAccounts = parseCategoryAccounts(v.deductionAccounts)

  return {
    v: 2,
    aggregationMode,
    trackingCategoryId,
    accounts,
    allowanceMode,
    allowanceAccounts,
    deductionMode,
    deductionAccounts,
  }
}

function parseGroupingMode(raw: unknown): XeroLineGroupingMode {
  if (
    typeof raw === "string" &&
    (xeroLineGroupingModes as readonly string[]).includes(raw)
  ) {
    return raw as XeroLineGroupingMode
  }
  return "UNIFIED"
}

function parseCategoryAccounts(
  raw: unknown,
): Record<string, string | null> {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, string | null> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "string" && val.length > 0) out[key] = val
    else if (val === null) out[key] = null
    // missing / wrong-typed values stay absent
  }
  return out
}

function toUpsertData(
  patch: Partial<Omit<PayrollSettingsData, "id" | "organizationId" | "createdAt" | "updatedAt">>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const copy = <K extends keyof typeof patch>(k: K) => {
    if (patch[k] !== undefined) out[k as string] = patch[k]
  }
  copy("workingDaysRule")
  copy("defaultEpfEmployeeRate")
  copy("defaultEpfEmployerRate")
  copy("hrdfEnabled")
  copy("hrdfRate")
  copy("autoApplySocsoEisRelief")
  copy("syncClaimsToXeroOnSubmit")
  copy("syncPayrollToXeroOnSubmit")
  copy("ecpPayorAccountNo")
  copy("ecpPayorBic")
  // The Json column round-trips through Prisma as `InputJsonValue`.
  // The domain shape is a plain object so it's safe to pass through.
  if (patch.xeroMapping !== undefined) {
    out.xeroMapping =
      patch.xeroMapping === null
        ? null
        : (patch.xeroMapping as unknown as Record<string, unknown>)
  }
  return out
}
