"use server"

import { revalidatePath } from "next/cache"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import type { BaseFormState } from "@/lib/form-state"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import {
  idTypes,
  payrollAdjustmentCategories,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import {
  PAYROLL_XERO_ACCOUNT_KEYS,
  workingDaysRules,
  xeroAggregationModes,
  xeroLineGroupingModes,
  type PayrollXeroMapping,
  type XeroLineGroupingMode,
} from "@/modules/payroll/domain/settings"
import {
  getXeroMappingOptions,
  upsertPayrollCompanyInfo,
  upsertPayrollSettings,
} from "@/modules/payroll/application/services/payroll-settings.service"

/**
 * Server actions for the payroll settings page. Two separate actions,
 * one per tab, because each tab writes to a different table.
 */

// ─── General tab → PayrollSettings ───────────────────────────────────────

const settingsSchema = z.object({
  // OT multipliers were removed — they now live on EmployeePolicy.
  workingDaysRule: z.enum(workingDaysRules),
  defaultEpfEmployeeRate: z.coerce.number().min(0).max(100),
  defaultEpfEmployerRate: z.coerce.number().min(0).max(100),
  hrdfEnabled: booleanString(),
  hrdfRate: nullableNumber(),
  autoApplySocsoEisRelief: booleanString(),
  syncClaimsToXeroOnSubmit: booleanString(),
  syncPayrollToXeroOnSubmit: booleanString(),
  // Public Bank ECP — 10-digit debiting account number. Empty / null
  // is fine (just disables the PB ECP file download). Validate as
  // either empty or exactly 10 digits to match the spec.
  ecpPayorAccountNo: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v == null || v === "" ? null : v.replace(/[^0-9]/g, "")))
    .refine(
      (v) => v === null || v.length === 10,
      "Public Bank account number must be exactly 10 digits.",
    ),
})

export async function savePayrollSettingsAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = settingsSchema.safeParse({
    workingDaysRule: formData.get("workingDaysRule"),
    defaultEpfEmployeeRate: formData.get("defaultEpfEmployeeRate"),
    defaultEpfEmployerRate: formData.get("defaultEpfEmployerRate"),
    hrdfEnabled: formData.get("hrdfEnabled"),
    hrdfRate: formData.get("hrdfRate"),
    autoApplySocsoEisRelief: formData.get("autoApplySocsoEisRelief"),
    syncClaimsToXeroOnSubmit: formData.get("syncClaimsToXeroOnSubmit"),
    syncPayrollToXeroOnSubmit: formData.get("syncPayrollToXeroOnSubmit"),
    ecpPayorAccountNo: formData.get("ecpPayorAccountNo"),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  try {
    await upsertPayrollSettings(parsed.data)
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not save settings."),
    }
  }

  // Audit AFTER the write succeeds. The service did its own session
  // check upstream — we just look up the same context for the
  // audit-row actor (cheap; cached in the request).
  const session = await getCurrentSession()
  const organizationId = session ? resolveActiveOrgId(session) : null
  if (session && organizationId && isAdminRole(session.role)) {
    void writeAudit({
      organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "payroll.settings.update",
      status: "SUCCESS",
      summary: `Updated payroll settings (EPF ${parsed.data.defaultEpfEmployeeRate}% / ${parsed.data.defaultEpfEmployerRate}%, HRDF ${parsed.data.hrdfEnabled ? "on" : "off"})`,
      targetType: "payroll-settings",
      metadata: parsed.data,
    })
  }

  revalidatePath("/admin/payroll/settings")
  return { status: "success", message: "General settings saved." }
}

// ─── Form E tab → PayrollCompanyInfo ─────────────────────────────────────

const companyInfoSchema = z.object({
  employerName: nullableString(),
  employerTin: nullableString(),
  registrationNo: nullableString(),
  referenceType: nullableString(),
  referenceNo: nullableString(),
  employerCategory: nullableString(),
  employerStatus: nullableString(),
  cp8dFurnishType: nullableString(),
  perkesoEmployerCode: nullableString(),
  addressLine1: nullableString(),
  addressLine2: nullableString(),
  postcode: nullableString(),
  city: nullableString(),
  state: nullableString(),
  country: nullableString(),
  phone: nullableString(),
  handphone: nullableString(),
  email: nullableString(),
  taxAgentName: nullableString(),
  taxAgentTin: nullableString(),
  taxAgentLicenceNo: nullableString(),
  taxAgentPhone: nullableString(),
  taxAgentEmail: nullableString(),
  taxAgentFirmName: nullableString(),
  taxAgentFirmAddressLine1: nullableString(),
  taxAgentFirmAddressLine2: nullableString(),
  taxAgentFirmPostcode: nullableString(),
  taxAgentFirmCity: nullableString(),
  taxAgentFirmState: nullableString(),
  declarantName: nullableString(),
  declarantIdType: nullableEnum(idTypes),
  declarantIdNumber: nullableString(),
  declarantPosition: nullableString(),
})

export async function savePayrollCompanyInfoAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = companyInfoSchema.safeParse(
    Object.fromEntries(
      [
        "employerName",
        "employerTin",
        "registrationNo",
        "referenceType",
        "referenceNo",
        "employerCategory",
        "employerStatus",
        "cp8dFurnishType",
        "perkesoEmployerCode",
        "addressLine1",
        "addressLine2",
        "postcode",
        "city",
        "state",
        "country",
        "phone",
        "handphone",
        "email",
        "taxAgentName",
        "taxAgentTin",
        "taxAgentLicenceNo",
        "taxAgentPhone",
        "taxAgentEmail",
        "taxAgentFirmName",
        "taxAgentFirmAddressLine1",
        "taxAgentFirmAddressLine2",
        "taxAgentFirmPostcode",
        "taxAgentFirmCity",
        "taxAgentFirmState",
        "declarantName",
        "declarantIdType",
        "declarantIdNumber",
        "declarantPosition",
      ].map((k) => [k, formData.get(k)]),
    ),
  )

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // The country field has a default in the DB ("Malaysia"), so we treat
  // "" / null as "keep the default" rather than overwriting with empty.
  // Also strips the `null` from the type so it satisfies
  // PayrollCompanyInfoData["country"] (which is a non-nullable string).
  const { country, ...rest } = parsed.data
  const patch: Partial<{
    [K in keyof typeof parsed.data]: NonNullable<(typeof parsed.data)[K]> | null
  }> & { country?: string } =
    country == null ? { ...rest } : { ...rest, country }

  try {
    await upsertPayrollCompanyInfo(patch)
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not save company info."),
    }
  }

  const session = await getCurrentSession()
  const organizationId = session ? resolveActiveOrgId(session) : null
  if (session && organizationId && isAdminRole(session.role)) {
    void writeAudit({
      organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "payroll.company-info.update",
      status: "SUCCESS",
      summary: `Updated payroll company info (employer "${parsed.data.employerName ?? "—"}")`,
      targetType: "payroll-company-info",
      metadata: {
        employerName: parsed.data.employerName,
        employerTin: parsed.data.employerTin,
        registrationNo: parsed.data.registrationNo,
      },
    })
  }

  revalidatePath("/admin/payroll/settings")
  return { status: "success", message: "Form E details saved." }
}

// ─── Zod helpers (mirror the ones in employees/[id]/actions.ts) ──────────

function nullableString() {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = v.trim()
      return t.length > 0 ? t : null
    })
}
function nullableNumber() {
  return z
    .union([z.string(), z.number(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      if (typeof v === "number") return v
      const t = v.trim()
      if (t.length === 0) return null
      const n = Number(t)
      return Number.isFinite(n) ? n : null
    })
}
function nullableEnum<T extends readonly string[]>(values: T) {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = String(v).trim()
      return (values as readonly string[]).includes(t) ? (t as T[number]) : null
    })
}
function booleanString() {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return false
      const t = String(v).toLowerCase().trim()
      return t === "true" || t === "on" || t === "1"
    })
}

// ─── Xero mapping tab → PayrollSettings.xeroMapping ──────────────────────

export type XeroMappingOptionsActionResult =
  | {
      status: "success"
      options: NonNullable<Awaited<ReturnType<typeof getXeroMappingOptions>>>
    }
  | {
      status: "empty"
      reason:
        | "no_session"
        | "no_org"
        | "no_connection"
        | "xero_unreachable"
    }
  | { status: "error"; message: string }

/**
 * Returns the COA + tracking-category options the admin can pick
 * from in the Xero mapping form. Called once when the tab opens.
 *
 * Distinguishes "not configured" (empty state) from "fetch error"
 * (toast) so the UI can render the right empty-state message.
 */
export async function getXeroPayrollMappingOptionsAction(): Promise<XeroMappingOptionsActionResult> {
  try {
    const options = await getXeroMappingOptions()
    if (!options) {
      return { status: "empty", reason: "no_connection" }
    }
    return { status: "success", options }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not load Xero options."),
    }
  }
}

const xeroMappingSchema = z.object({
  aggregationMode: z.enum(xeroAggregationModes),
  trackingCategoryId: nullableString(),
  // Per-account fields are normalised below (all 16 keys at once).
})

export async function savePayrollXeroMappingAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const baseParsed = xeroMappingSchema.safeParse({
    aggregationMode: formData.get("aggregationMode"),
    trackingCategoryId: formData.get("trackingCategoryId"),
  })

  if (!baseParsed.success) {
    return {
      status: "error",
      message: baseParsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // Pull each account ID by key. Empty/missing values become null
  // (admin hasn't configured this category yet).
  const accounts: Partial<Record<string, string | null>> = {}
  for (const key of PAYROLL_XERO_ACCOUNT_KEYS) {
    const raw = formData.get(`account.${key}`)
    if (raw == null || raw instanceof File) {
      accounts[key] = null
      continue
    }
    const v = String(raw).trim()
    accounts[key] = v.length > 0 ? v : null
  }

  // Allowance / deduction mode toggles + per-category maps. Persisted
  // even when the toggle is UNIFIED so the admin doesn't lose their
  // per-category picks when flipping back and forth.
  const allowanceModeRaw = formData.get("allowanceMode")
  const allowanceMode: XeroLineGroupingMode =
    typeof allowanceModeRaw === "string" &&
    (xeroLineGroupingModes as readonly string[]).includes(allowanceModeRaw)
      ? (allowanceModeRaw as XeroLineGroupingMode)
      : "UNIFIED"
  const deductionModeRaw = formData.get("deductionMode")
  const deductionMode: XeroLineGroupingMode =
    typeof deductionModeRaw === "string" &&
    (xeroLineGroupingModes as readonly string[]).includes(deductionModeRaw)
      ? (deductionModeRaw as XeroLineGroupingMode)
      : "UNIFIED"

  const allowanceAccounts: Record<string, string | null> = {}
  const deductionAccounts: Record<string, string | null> = {}
  // We iterate the canonical category list to ignore any junk keys an
  // attacker might inject. Empty strings → null.
  const validCategoryKeys = new Set<PayrollAdjustmentCategory>(
    payrollAdjustmentCategories,
  )
  for (const key of validCategoryKeys) {
    const a = formData.get(`allowanceAccount.${key}`)
    if (typeof a === "string") {
      const v = a.trim()
      allowanceAccounts[key] = v.length > 0 ? v : null
    }
    const d = formData.get(`deductionAccount.${key}`)
    if (typeof d === "string") {
      const v = d.trim()
      deductionAccounts[key] = v.length > 0 ? v : null
    }
  }

  const xeroMapping: PayrollXeroMapping = {
    v: 2,
    aggregationMode: baseParsed.data.aggregationMode,
    trackingCategoryId: baseParsed.data.trackingCategoryId,
    accounts,
    allowanceMode,
    allowanceAccounts,
    deductionMode,
    deductionAccounts,
  }

  try {
    await upsertPayrollSettings({ xeroMapping })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not save Xero mapping."),
    }
  }

  revalidatePath("/admin/payroll/settings")
  return { status: "success", message: "Xero mapping saved." }
}
