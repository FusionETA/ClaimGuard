"use server"

import { revalidatePath } from "next/cache"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { getCurrentSession } from "@/lib/auth/session"
import type { BaseFormState } from "@/lib/form-state"
import type { PayrollProfileFormState } from "./form-state"
import {
  childAbilityStatuses,
  childPcbDeductionLevels,
  childStudyingLevels,
  genders,
  idTypes,
  maritalStatuses,
  paymentMethods,
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  payrollAdjustmentCategories,
  salaryTypes,
  socsoSchemes,
  type FixedAllowance,
} from "@/modules/payroll/domain/models"
import { SALARY_CHANGE_REASONS } from "@/modules/payroll/domain/salary-change"
import {
  archivePayrollProfile,
  unarchivePayrollProfile,
  updateEmployeeEmail,
  updateEmployeeName,
  upsertPayrollProfile,
} from "@/modules/payroll/application/services/payroll-profile.service"
import {
  cancelEmployeeTransfer,
  createEmployeeTransfer,
} from "@/modules/payroll/application/services/payroll-transfer.service"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { salaryChangeRepository } from "@/modules/payroll/infrastructure/salary-change.repository"

/**
 * Server actions for the payroll-employee detail tabs.
 *
 * Each tab is a separate action so the admin can save one tab without
 * blocking on incomplete fields in another. The service does session +
 * org scoping; here we just parse + validate.
 */

// ─── Personal tab ─────────────────────────────────────────────────────────

const personalSchema = z.object({
  /// Full name — lives on `User.name`. Persisted via a separate
  /// `updateEmployeeName` service call inside the action (same
  /// split-persistence pattern as `email` below).
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(120, "Name is too long."),
  /// Primary (login) email. Required + validated here; persistence is
  /// split into a separate `updateEmployeeEmail` service call inside the
  /// action because this field lives on `User`, not `PayrollProfile`.
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email."),
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
  _prev: PayrollProfileFormState,
  formData: FormData,
): Promise<PayrollProfileFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) {
    return { status: "error", message: "Missing employee id." }
  }

  const parsed = personalSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
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
    // No `?? "true"` fallback here on purpose. An unchecked HTML
    // checkbox is absent from FormData entirely — the fallback used
    // to slam it back to `"true"`, which the Zod booleanString()
    // transform parsed as true. Admins unticking "Resident (tax)?"
    // for a non-Malaysian saw the toggle revert on refresh because
    // the false value never reached the DB. Matching the
    // hasPr / isOku pattern below: `null` from formData → Zod
    // booleanString() → false.
    isResident: formData.get("isResident"),
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

  // Strip `name` + `email` from the PayrollProfile patch — both live on
  // `User` and are persisted via separate service calls below. The
  // rest of `parsed.data` is shaped for PayrollProfile.
  const { name: newName, email: newEmail, ...payrollPatch } = parsed.data

  let staleDraftRuns:
    | Array<{ id: string; periodYear: number; periodMonth: number }>
    | undefined
  try {
    const result = await upsertPayrollProfile({
      userId,
      patch: {
        ...payrollPatch,
        childRelief,
      },
    })
    staleDraftRuns = result.staleDraftRuns
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not save profile."),
    }
  }

  // Persist the name change on User. Cheap — no uniqueness check
  // needed (names aren't unique keys); the service just runs an update.
  try {
    await updateEmployeeName({ userId, newName })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not update name."),
    }
  }

  // Persist the email change on User. Catches the friendly "already in
  // use" message from the service when the new address collides with
  // another user — that path returns an error toast without rolling
  // back the PayrollProfile save (the profile data is still valid; only
  // the email field is what wasn't accepted).
  try {
    await updateEmployeeEmail({ userId, newEmail })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not update email."),
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return {
    status: "success",
    message: "Personal details saved.",
    staleDraftRuns,
  }
}

// ─── Employment tab ───────────────────────────────────────────────────────

const employmentSchema = z.object({
  salaryType: z.enum(salaryTypes),
  monthlySalary: nullableNumber(),
  hourlyRate: nullableNumber(),
  joinDate: nullableDateString(),
  // `leaveDate` intentionally NOT here — it's owned by the Archive
  // section (see `archivePayrollProfileAction` below). Saving the
  // Employment form must never touch leaveDate, otherwise a re-save
  // would clear an existing archive date because this form has no
  // input for it anymore.
  department: nullableString(),
  location: nullableString(),
  workSchedule: nullableString(),
  payrollPolicy: nullableString(),
  payrollCycle: nullableString(),
  prevEmploymentYear: nullableInt(),
  prevRemuneration: nullableNumber(),
  prevEpf: nullableNumber(),
  prevPcb: nullableNumber(),
  prevZakat: nullableNumber(),
  prevAllowableDeductions: nullableNumber(),
  // Salary-change classification — sent by the form when the admin
  // actually changes salary. The UI prompts them to pick "TYPO" (no
  // history entry) or one of the real reasons (creates a
  // SalaryChange row). FormData always sends a value (the hidden
  // input defaults to ""), so we accept any of:
  //   - "" / null / File → unchanged-salary save, no history row
  //   - "TYPO" → typo correction, no history row
  //   - one of SALARY_CHANGE_REASONS → real change, history row
  salaryChangeKind: z
    .union([z.string(), z.null(), z.instanceof(File)])
    .transform((v) => {
      if (v == null || v instanceof File) return null
      const t = v.trim()
      if (t === "") return null
      if (t === "TYPO") return "TYPO" as const
      const reasons = SALARY_CHANGE_REASONS as readonly string[]
      if (reasons.includes(t)) return t as (typeof SALARY_CHANGE_REASONS)[number]
      return null
    }),
  salaryChangeEffectiveDate: nullableDateString(),
  salaryChangeNotes: nullableString(),
})

export async function savePayrollEmploymentAction(
  _prev: PayrollProfileFormState,
  formData: FormData,
): Promise<PayrollProfileFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) {
    return { status: "error", message: "Missing employee id." }
  }

  const parsed = employmentSchema.safeParse({
    salaryType: formData.get("salaryType"),
    monthlySalary: formData.get("monthlySalary"),
    hourlyRate: formData.get("hourlyRate"),
    joinDate: formData.get("joinDate"),
    // leaveDate intentionally omitted — see schema comment above.
    department: formData.get("department"),
    location: formData.get("location"),
    workSchedule: formData.get("workSchedule"),
    payrollPolicy: formData.get("payrollPolicy"),
    payrollCycle: formData.get("payrollCycle"),
    prevEmploymentYear: formData.get("prevEmploymentYear"),
    prevRemuneration: formData.get("prevRemuneration"),
    prevEpf: formData.get("prevEpf"),
    prevPcb: formData.get("prevPcb"),
    prevZakat: formData.get("prevZakat"),
    prevAllowableDeductions: formData.get("prevAllowableDeductions"),
    salaryChangeKind: formData.get("salaryChangeKind"),
    salaryChangeEffectiveDate: formData.get("salaryChangeEffectiveDate"),
    salaryChangeNotes: formData.get("salaryChangeNotes"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // Cross-field rules:
  if (parsed.data.salaryType === "MONTHLY" && parsed.data.monthlySalary == null) {
    return {
      status: "error",
      message: "Monthly salary is required when salary type is MONTHLY.",
    }
  }
  if (parsed.data.salaryType === "HOURLY" && parsed.data.hourlyRate == null) {
    return {
      status: "error",
      message: "Hourly rate is required when salary type is HOURLY.",
    }
  }

  const fixedAllowances = parseFixedAllowancesFromForm(formData)

  // Snapshot the existing salary BEFORE the upsert so we can compare
  // and (if the admin classified the change as a real one) record a
  // SalaryChange audit row.
  const existing = await payrollProfileRepository.getByUserId(userId)
  const session = await getCurrentSession()
  const changedByUserId = session?.userId ?? null

  // Destructure the salary-change classification away from the
  // PayrollProfile patch so it doesn't leak into the repo upsert.
  const {
    salaryChangeKind,
    salaryChangeEffectiveDate,
    salaryChangeNotes,
    ...profilePatch
  } = parsed.data

  let staleDraftRuns:
    | Array<{ id: string; periodYear: number; periodMonth: number }>
    | undefined
  try {
    const result = await upsertPayrollProfile({
      userId,
      patch: {
        ...profilePatch,
        fixedAllowances,
      },
    })
    staleDraftRuns = result.staleDraftRuns
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not save profile."),
    }
  }

  // Record an audit-grade salary history row when:
  //   - the salary actually changed (either MONTHLY value, HOURLY
  //     rate, or the salary type itself);
  //   - the admin classified the change as a real one (not TYPO);
  //   - we know which EmployeeProfile to attach it to.
  //
  // Best-effort: a failure to write the history row does NOT roll
  // back the profile update. The admin's primary task (save the
  // salary) is done; the audit log just gets a console.error so we
  // can investigate.
  if (
    existing &&
    salaryChangeKind &&
    salaryChangeKind !== "TYPO" &&
    salaryActuallyChanged(existing, profilePatch)
  ) {
    try {
      await salaryChangeRepository.create({
        employeeProfileId: existing.employeeProfileId,
        effectiveDate:
          salaryChangeEffectiveDate ??
          new Date().toISOString().slice(0, 10),
        previousSalaryType: existing.salaryType,
        previousMonthlySalary: existing.monthlySalary,
        previousHourlyRate: existing.hourlyRate,
        newSalaryType: profilePatch.salaryType,
        newMonthlySalary: profilePatch.monthlySalary,
        newHourlyRate: profilePatch.hourlyRate,
        reason: salaryChangeKind,
        notes: salaryChangeNotes ?? null,
        changedByUserId,
      })
    } catch (err) {
      console.error(
        "[salary-history] failed to record SalaryChange row:",
        err,
      )
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return {
    status: "success",
    message: "Employment details saved.",
    staleDraftRuns,
  }
}

/**
 * Did the salary actually change between the stored profile and the
 * patch the admin just submitted? Compares all three salary fields
 * (type, monthly amount, hourly rate). Returns false if every value
 * matches.
 */
function salaryActuallyChanged(
  existing: {
    salaryType: (typeof salaryTypes)[number]
    monthlySalary: number | null
    hourlyRate: number | null
  },
  patch: {
    salaryType: (typeof salaryTypes)[number]
    monthlySalary: number | null
    hourlyRate: number | null
  },
): boolean {
  if (existing.salaryType !== patch.salaryType) return true
  if ((existing.monthlySalary ?? null) !== (patch.monthlySalary ?? null)) {
    return true
  }
  if ((existing.hourlyRate ?? null) !== (patch.hourlyRate ?? null)) {
    return true
  }
  return false
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
  contributeToSkbbk: booleanString(),
  incomeTaxNumber: nullableString(),
  pcbBorneByEmployer: booleanString(),
  ssfwNumber: nullableString(),
  paymentMethod: z.enum(paymentMethods),
  bankName: nullableString(),
  bankAccountHolderName: nullableString(),
  bankAccountNumber: nullableString(),
})

export async function savePayrollStatutoryAction(
  _prev: PayrollProfileFormState,
  formData: FormData,
): Promise<PayrollProfileFormState> {
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
    contributeToSkbbk: formData.get("contributeToSkbbk"),
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

  let staleDraftRuns:
    | Array<{ id: string; periodYear: number; periodMonth: number }>
    | undefined
  try {
    const result = await upsertPayrollProfile({
      userId,
      patch: parsed.data,
    })
    staleDraftRuns = result.staleDraftRuns
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not save profile."),
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return {
    status: "success",
    message: "Statutory details saved.",
    staleDraftRuns,
  }
}

// ─── Archive / unarchive ──────────────────────────────────────────────────

export async function archivePayrollProfileAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  const reason = String(formData.get("reason") ?? "").trim()
  // Last working day. Required — drives proration of the final
  // payroll run. Browser `<input type="date">` posts ISO `YYYY-MM-DD`
  // when set, "" otherwise.
  const leaveDateRaw = String(formData.get("leaveDate") ?? "").trim()
  if (!userId) return { status: "error", message: "Missing employee id." }
  if (!leaveDateRaw) {
    return {
      status: "error",
      message: "Pick the employee's last working day before archiving.",
    }
  }
  // Validate the date is parseable. `new Date('2026-05-20')` interprets
  // the string in UTC, which is fine for a date-only value — the calc
  // engine works in day units, not timestamps.
  const leaveDate = new Date(leaveDateRaw)
  if (Number.isNaN(leaveDate.getTime())) {
    return {
      status: "error",
      message: "Last working day is not a valid date.",
    }
  }

  try {
    await archivePayrollProfile({
      userId,
      reason: reason || "Archived",
      leaveDate,
    })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not archive."),
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

  // Rehire-with-other-employer path: when admin answered "yes" in the
  // restore dialog, the form posts the carryover TP3 figures. We pass
  // them through to the service so the run engine deducts this org's
  // existing YTD before adding (prevents double-count).
  const workedElsewhere =
    String(formData.get("workedElsewhereDuringAbsence") ?? "").toLowerCase() ===
    "true"
  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim()
    if (raw.length === 0) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  const rehireCarryover = workedElsewhere
    ? {
        prevEmploymentYear: (() => {
          const raw = String(formData.get("prevEmploymentYear") ?? "").trim()
          const n = parseInt(raw, 10)
          return Number.isFinite(n) ? n : new Date().getFullYear()
        })(),
        prevRemuneration: num("prevRemuneration"),
        prevEpf: num("prevEpf"),
        prevPcb: num("prevPcb"),
        prevZakat: num("prevZakat"),
      }
    : null

  try {
    await unarchivePayrollProfile({ userId, rehireCarryover })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not unarchive."),
    }
  }

  revalidatePath("/admin/payroll/employees")
  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Employee restored to payroll." }
}

// ─── Transfer actions ────────────────────────────────────────────────────

const transferSchema = z.object({
  sourceEmployeeProfileId: z.string().min(1, "Missing employee profile."),
  targetOrganizationId: z.string().min(1, "Pick a target company."),
  targetPolicyId: z.string().min(1, "Pick a payroll policy at the target."),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Effective date is invalid."),
  copyPayrollInfo: booleanString(),
  notes: nullableString(),
})

export async function transferEmployeeAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  const parsed = transferSchema.safeParse({
    sourceEmployeeProfileId: formData.get("sourceEmployeeProfileId"),
    targetOrganizationId: formData.get("targetOrganizationId"),
    targetPolicyId: formData.get("targetPolicyId"),
    effectiveDate: formData.get("effectiveDate"),
    copyPayrollInfo: formData.get("copyPayrollInfo"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  try {
    const result = await createEmployeeTransfer({
      sourceEmployeeProfileId: parsed.data.sourceEmployeeProfileId,
      targetOrganizationId: parsed.data.targetOrganizationId,
      targetPolicyId: parsed.data.targetPolicyId,
      effectiveDate: parsed.data.effectiveDate,
      copyPayrollInfo: parsed.data.copyPayrollInfo,
      notes: parsed.data.notes,
    })
    revalidatePath("/admin/hierarchy")
    revalidatePath("/admin/payroll/employees")
    if (userId) revalidatePath(`/admin/payroll/employees/${userId}`)
    return {
      status: "success",
      message: result.executedImmediately
        ? "Transfer executed. Employee is now active at the target company."
        : `Transfer scheduled for ${parsed.data.effectiveDate}. It will run automatically on that day.`,
    }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not schedule transfer."),
    }
  }
}

export async function cancelTransferAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  const transferId = String(formData.get("transferId") ?? "").trim()
  if (!transferId) {
    return { status: "error", message: "Missing transfer id." }
  }
  try {
    await cancelEmployeeTransfer({ transferId })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not cancel transfer."),
    }
  }
  revalidatePath("/admin/hierarchy")
  revalidatePath("/admin/payroll/employees")
  if (userId) revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Pending transfer cancelled." }
}

// ─── Documents tab actions ───────────────────────────────────────────────

export async function uploadPayrollDocumentAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  if (!userId) {
    return { status: "error", message: "Missing employee id." }
  }
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return { status: "error", message: "No file uploaded." }
  }

  try {
    const { uploadPayrollDocument } = await import(
      "@/modules/payroll/application/services/payroll-documents.service"
    )
    await uploadPayrollDocument({ userId, file })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Upload failed."),
    }
  }

  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Document uploaded." }
}

export async function deletePayrollDocumentAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const userId = String(formData.get("userId") ?? "").trim()
  const documentId = String(formData.get("documentId") ?? "").trim()
  if (!userId || !documentId) {
    return { status: "error", message: "Missing employee or document id." }
  }
  try {
    const { deletePayrollDocument } = await import(
      "@/modules/payroll/application/services/payroll-documents.service"
    )
    await deletePayrollDocument({ userId, documentId })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Delete failed."),
    }
  }

  revalidatePath(`/admin/payroll/employees/${userId}`)
  return { status: "success", message: "Document removed." }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse child relief from form data. The form names fields as
 * `child0.age`, `child0.abilityStatus`, etc. Up to 4 slots supported
 * (matches PayrollPanda's template).
 */
function parseChildReliefFromForm(formData: FormData) {
  const out: Array<{
    abilityStatus: (typeof childAbilityStatuses)[number]
    currentlyStudying: (typeof childStudyingLevels)[number]
    pcbDeduction: (typeof childPcbDeductionLevels)[number]
  }> = []
  for (let i = 0; i < 10; i += 1) {
    // A slot is "present" when it emits a currentlyStudying value —
    // even the default UNDER_18 is a positive signal. The old code
    // used age as the presence marker; we now use studying level.
    const studyingRaw = formData.get(`child${i}.currentlyStudying`)
    if (studyingRaw === null) continue
    const studying = String(studyingRaw)
    const ability = String(formData.get(`child${i}.abilityStatus`) ?? "NORMAL")
    const pcb = String(formData.get(`child${i}.pcbDeduction`) ?? "NONE")
    out.push({
      abilityStatus: childAbilityStatuses.includes(ability as never)
        ? (ability as (typeof childAbilityStatuses)[number])
        : "NORMAL",
      currentlyStudying: childStudyingLevels.includes(studying as never)
        ? (studying as (typeof childStudyingLevels)[number])
        : "UNDER_18",
      pcbDeduction: childPcbDeductionLevels.includes(pcb as never)
        ? (pcb as (typeof childPcbDeductionLevels)[number])
        : "NONE",
    })
  }
  return out
}

/**
 * Parse fixed adjustments from form data. Field naming:
 *   `allowance0.category` / `allowance0.name` / `allowance0.amount`,
 *   `allowance1.category` / ...
 * Supports up to 20 recurring adjustment slots.
 */
function parseFixedAllowancesFromForm(formData: FormData): FixedAllowance[] {
  const out: FixedAllowance[] = []
  for (let i = 0; i < 20; i += 1) {
    // Skip slots that don't actually exist in the form. Without this
    // guard, `formData.get()` returns null for missing keys and
    // `Number(null)` collapses to 0 — silently pushing phantom
    // zero-amount rows on every save. (Bug fix: previously every save
    // accumulated up to 20 "Standard Allowance · RM 0" rows in the
    // PayrollProfile.fixedAllowances JSON column.)
    const categoryField = formData.get(`allowance${i}.category`)
    const nameField = formData.get(`allowance${i}.name`)
    const amountField = formData.get(`allowance${i}.amount`)
    if (
      categoryField == null &&
      nameField == null &&
      amountField == null
    ) {
      continue
    }

    const categoryRaw = String(categoryField ?? "allowance_standard").trim()
    const category = payrollAdjustmentCategories.includes(categoryRaw as never)
      ? (categoryRaw as FixedAllowance["category"])
      : "allowance_standard"
    const fallbackLabel = PAYROLL_ADJUSTMENT_CATEGORY_META[category].label
    const name = String(nameField ?? "").trim() || fallbackLabel
    const amount = Number(amountField)
    // A zero/negative recurring allowance is meaningless for payroll —
    // skip it so the admin can clear a row by zeroing it out (rather
    // than having to delete the row, save, then re-add).
    if (!Number.isFinite(amount) || amount <= 0) continue
    // LHDN AR override: when admin ticked "Treat as regular monthly
    // remuneration" on this row, persist it so calc.ts routes the
    // amount through the normal PCB bucket instead of the AR bucket.
    const treatAsRecurringField = formData.get(`allowance${i}.treatAsRecurring`)
    const treatAsRecurring =
      String(treatAsRecurringField ?? "").toLowerCase() === "true"
    out.push({
      category,
      name,
      amount,
      ...(treatAsRecurring ? { treatAsRecurring } : {}),
    })
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
