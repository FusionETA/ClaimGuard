"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { BaseFormState } from "@/lib/form-state"
import {
  childAbilityStatuses,
  childPcbDeductionLevels,
  childStudyingLevels,
  genders,
  idTypes,
  maritalStatuses,
  paymentMethods,
  salaryTypes,
  socsoSchemes,
  type FixedAllowance,
} from "@/modules/payroll/domain/models"
import {
  archivePayrollProfile,
  unarchivePayrollProfile,
  upsertPayrollProfile,
} from "@/modules/payroll/application/services/payroll-profile.service"

/**
 * Server actions for the payroll-employee detail tabs.
 *
 * Each tab is a separate action so the admin can save one tab without
 * blocking on incomplete fields in another. The service does session +
 * org scoping; here we just parse + validate.
 */

// ─── Personal tab ─────────────────────────────────────────────────────────

const personalSchema = z.object({
  phone: nullableString(),
  alternateEmail: nullableEmail(),
  gender: nullableEnum(genders),
  dateOfBirth: nullableDateString(),
  nationality: nullableString(),
  race: nullableString(),
  hasPr: booleanString(),
  idType: nullableEnum(idTypes),
  idNumber: nullableString(),
  maritalStatus: nullableEnum(maritalStatuses),
  isResident: booleanString(),
  isOku: booleanString(),
  spouseWorking: nullableBoolean(),
  spouseDisabled: nullableBoolean(),
  spousePcbNumber: nullableString(),
  spouseIdNumber: nullableString(),
  addressLine1: nullableString(),
  addressLine2: nullableString(),
  addressLine3: nullableString(),
  city: nullableString(),
  postcode: nullableString(),
  state: nullableString(),
  emergencyContactName: nullableString(),
  emergencyContactPhone: nullableString(),
  emergencyContactRelation: nullableString(),
  // Children encoded as repeated form fields child[i].field; serialise
  // outside the schema before passing here.
})

export async function savePayrollPersonalAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) {
    return { status: "error", message: "Missing employee id." }
  }

  const parsed = personalSchema.safeParse({
    phone: formData.get("phone"),
    alternateEmail: formData.get("alternateEmail"),
    gender: formData.get("gender"),
    dateOfBirth: formData.get("dateOfBirth"),
    nationality: formData.get("nationality"),
    race: formData.get("race"),
    hasPr: formData.get("hasPr"),
    idType: formData.get("idType"),
    idNumber: formData.get("idNumber"),
    maritalStatus: formData.get("maritalStatus"),
    isResident: formData.get("isResident") ?? "true",
    isOku: formData.get("isOku"),
    spouseWorking: formData.get("spouseWorking"),
    spouseDisabled: formData.get("spouseDisabled"),
    spousePcbNumber: formData.get("spousePcbNumber"),
    spouseIdNumber: formData.get("spouseIdNumber"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2"),
    addressLine3: formData.get("addressLine3"),
    city: formData.get("city"),
    postcode: formData.get("postcode"),
    state: formData.get("state"),
    emergencyContactName: formData.get("emergencyContactName"),
    emergencyContactPhone: formData.get("emergencyContactPhone"),
    emergencyContactRelation: formData.get("emergencyContactRelation"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // Parse child relief from repeated form fields child0.age / child0.abilityStatus / ...
  const childRelief = parseChildReliefFromForm(formData)

  try {
    await upsertPayrollProfile({
      userId,
      patch: {
        ...parsed.data,
        childRelief,
      },
    })
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Could not save profile.",
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Personal details saved." }
}

// ─── Employment tab ───────────────────────────────────────────────────────

const employmentSchema = z.object({
  salaryType: z.enum(salaryTypes),
  monthlySalary: nullableNumber(),
  hourlyRate: nullableNumber(),
  joinDate: nullableDateString(),
  leaveDate: nullableDateString(),
  department: nullableString(),
  location: nullableString(),
  workSchedule: nullableString(),
  payrollPolicy: nullableString(),
  payrollCycle: nullableString(),
  prevEmploymentYear: nullableInt(),
  prevRemuneration: nullableNumber(),
  prevEpf: nullableNumber(),
})

export async function savePayrollEmploymentAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) {
    return { status: "error", message: "Missing employee id." }
  }

  const parsed = employmentSchema.safeParse({
    salaryType: formData.get("salaryType"),
    monthlySalary: formData.get("monthlySalary"),
    hourlyRate: formData.get("hourlyRate"),
    joinDate: formData.get("joinDate"),
    leaveDate: formData.get("leaveDate"),
    department: formData.get("department"),
    location: formData.get("location"),
    workSchedule: formData.get("workSchedule"),
    payrollPolicy: formData.get("payrollPolicy"),
    payrollCycle: formData.get("payrollCycle"),
    prevEmploymentYear: formData.get("prevEmploymentYear"),
    prevRemuneration: formData.get("prevRemuneration"),
    prevEpf: formData.get("prevEpf"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // Cross-field rules:
  if (parsed.data.salaryType === "MONTHLY" && !parsed.data.monthlySalary) {
    return {
      status: "error",
      message: "Monthly salary is required when salary type is MONTHLY.",
    }
  }
  if (parsed.data.salaryType === "HOURLY" && !parsed.data.hourlyRate) {
    return {
      status: "error",
      message: "Hourly rate is required when salary type is HOURLY.",
    }
  }

  const fixedAllowances = parseFixedAllowancesFromForm(formData)

  try {
    await upsertPayrollProfile({
      userId,
      patch: {
        ...parsed.data,
        fixedAllowances,
      },
    })
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Could not save profile.",
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Employment details saved." }
}

// ─── Statutory tab ────────────────────────────────────────────────────────

const statutorySchema = z.object({
  contributeToEpf: booleanString(),
  epfMemberBefore1998: booleanString(),
  epfNumber: nullableString(),
  epfEmployeeRate: z.coerce.number().min(0).max(100),
  epfEmployeeVoluntary: z.coerce.number().min(0).max(100),
  epfEmployerVoluntary: z.coerce.number().min(0).max(100),
  socsoScheme: nullableEnum(socsoSchemes),
  socsoNumber: nullableString(),
  contributeToEis: booleanString(),
  incomeTaxNumber: nullableString(),
  pcbBorneByEmployer: booleanString(),
  ssfwNumber: nullableString(),
  paymentMethod: z.enum(paymentMethods),
  bankName: nullableString(),
  bankAccountHolderName: nullableString(),
  bankAccountNumber: nullableString(),
})

export async function savePayrollStatutoryAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) {
    return { status: "error", message: "Missing employee id." }
  }

  const parsed = statutorySchema.safeParse({
    contributeToEpf: formData.get("contributeToEpf"),
    epfMemberBefore1998: formData.get("epfMemberBefore1998"),
    epfNumber: formData.get("epfNumber"),
    epfEmployeeRate: formData.get("epfEmployeeRate") ?? "11",
    epfEmployeeVoluntary: formData.get("epfEmployeeVoluntary") ?? "0",
    epfEmployerVoluntary: formData.get("epfEmployerVoluntary") ?? "0",
    socsoScheme: formData.get("socsoScheme"),
    socsoNumber: formData.get("socsoNumber"),
    contributeToEis: formData.get("contributeToEis"),
    incomeTaxNumber: formData.get("incomeTaxNumber"),
    pcbBorneByEmployer: formData.get("pcbBorneByEmployer"),
    ssfwNumber: formData.get("ssfwNumber"),
    paymentMethod: formData.get("paymentMethod") ?? "BANK_TRANSFER",
    bankName: formData.get("bankName"),
    bankAccountHolderName: formData.get("bankAccountHolderName"),
    bankAccountNumber: formData.get("bankAccountNumber"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  try {
    await upsertPayrollProfile({
      userId,
      patch: parsed.data,
    })
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Could not save profile.",
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Statutory details saved." }
}

// ─── Archive / unarchive ──────────────────────────────────────────────────

export async function archivePayrollProfileAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  const reason = String(formData.get("reason") ?? "").trim()
  if (!userId) return { status: "error", message: "Missing employee id." }

  try {
    await archivePayrollProfile({ userId, reason: reason || "Archived" })
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Could not archive.",
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Employee archived from payroll." }
}

export async function unarchivePayrollProfileAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) return { status: "error", message: "Missing employee id." }

  try {
    await unarchivePayrollProfile({ userId })
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Could not unarchive.",
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Employee restored to payroll." }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse child relief from form data. The form names fields as
 * `child0.age`, `child0.abilityStatus`, etc. Up to 4 slots supported
 * (matches PayrollPanda's template).
 */
function parseChildReliefFromForm(formData: FormData) {
  const out: Array<{
    age: number
    abilityStatus: (typeof childAbilityStatuses)[number]
    currentlyStudying: (typeof childStudyingLevels)[number]
    pcbDeduction: (typeof childPcbDeductionLevels)[number]
  }> = []
  for (let i = 0; i < 10; i += 1) {
    const ageRaw = formData.get(`child${i}.age`)
    if (ageRaw === null || ageRaw === "") continue
    const age = Number(ageRaw)
    if (!Number.isFinite(age)) continue
    const ability = String(formData.get(`child${i}.abilityStatus`) ?? "NORMAL")
    const studying = String(formData.get(`child${i}.currentlyStudying`) ?? "NONE")
    const pcb = String(formData.get(`child${i}.pcbDeduction`) ?? "NONE")
    out.push({
      age,
      abilityStatus: childAbilityStatuses.includes(ability as never)
        ? (ability as (typeof childAbilityStatuses)[number])
        : "NORMAL",
      currentlyStudying: childStudyingLevels.includes(studying as never)
        ? (studying as (typeof childStudyingLevels)[number])
        : "NONE",
      pcbDeduction: childPcbDeductionLevels.includes(pcb as never)
        ? (pcb as (typeof childPcbDeductionLevels)[number])
        : "NONE",
    })
  }
  return out
}

/**
 * Parse fixed allowances from form data. Field naming:
 *   `allowance0.name` / `allowance0.amount`, `allowance1.name` / ...
 * Supports up to 20 allowance slots.
 */
function parseFixedAllowancesFromForm(formData: FormData): FixedAllowance[] {
  const out: FixedAllowance[] = []
  for (let i = 0; i < 20; i += 1) {
    const name = String(formData.get(`allowance${i}.name`) ?? "").trim()
    const amountRaw = formData.get(`allowance${i}.amount`)
    if (!name) continue
    const amount = Number(amountRaw)
    if (!Number.isFinite(amount)) continue
    out.push({ name, amount })
  }
  return out
}

// ─── Zod helpers (free coercion from FormData strings) ───────────────────

function nullableString() {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = v.trim()
      return t.length > 0 ? t : null
    })
}
function nullableEmail() {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = v.trim()
      return t.length > 0 ? t : null
    })
}
function nullableDateString() {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = v.trim()
      if (t.length === 0) return null
      const d = new Date(t)
      return Number.isNaN(d.getTime()) ? null : t // keep as ISO yyyy-mm-dd
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
function nullableBoolean() {
  return z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = String(v).toLowerCase().trim()
      if (t === "true" || t === "on" || t === "1") return true
      if (t === "false" || t === "off" || t === "0") return false
      return null
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
