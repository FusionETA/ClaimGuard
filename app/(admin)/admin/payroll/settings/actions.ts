"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { BaseFormState } from "@/lib/form-state"
import { idTypes } from "@/modules/payroll/domain/models"
import { workingDaysRules } from "@/modules/payroll/domain/settings"
import {
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
  employerIdNumber: nullableString(),
  myCoOrSsmNumber: nullableString(),
  leaveCarryForwardAllowed: booleanString(),
  leaveCarryForwardLimitDays: nullableInt(),
  leaveCarryForwardExpiryMonths: nullableInt(),
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
    employerIdNumber: formData.get("employerIdNumber"),
    myCoOrSsmNumber: formData.get("myCoOrSsmNumber"),
    leaveCarryForwardAllowed: formData.get("leaveCarryForwardAllowed"),
    leaveCarryForwardLimitDays: formData.get("leaveCarryForwardLimitDays"),
    leaveCarryForwardExpiryMonths: formData.get("leaveCarryForwardExpiryMonths"),
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
      message: err instanceof Error ? err.message : "Could not save settings.",
    }
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
        err instanceof Error ? err.message : "Could not save company info.",
    }
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
function nullableInt() {
  return z
    .union([z.string(), z.number(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null
      const t = v.trim()
      if (t.length === 0) return null
      const n = parseInt(t, 10)
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
