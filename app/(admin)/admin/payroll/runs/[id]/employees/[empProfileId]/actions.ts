"use server"

import { revalidatePath } from "next/cache"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import type { BaseFormState } from "@/lib/form-state"
import {
  clearPayrollAdjustment,
  getPayrollAdjustmentPageData,
  previewEmployeeNetForRun,
  savePayrollAdjustment,
} from "@/modules/payroll/application/services/payroll-run.service"
import {
  payrollAdjustmentCategories,
  type FixedAllowance,
} from "@/modules/payroll/domain/models"
import type {
  FixedAllowanceOverrideMap,
  ManualLineItem,
  PayrollRunAdjustmentData,
} from "@/modules/payroll/domain/runs"

/**
 * Server actions for the per-employee adjustment form. One form
 * covers OT hours, one-off allowances + deductions, unpaid-leave
 * deduction, and admin notes.
 *
 * Manual line items arrive as repeated form fields:
 *   line[0].kind / line[0].label / line[0].amount
 *   line[1].kind / ...
 * — we walk indexes 0..50 until we run out.
 */

/// Parse an optional non-negative hours field. Empty string / null →
/// null (use the auto-computed default). Non-numeric or negative → null.
function coerceOptionalHours(v: string | null): number | null {
  if (v == null) return null
  const t = v.trim()
  if (t.length === 0) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}

const adjustmentSchema = z.object({
  runId: z.string().min(1),
  employeeProfileId: z.string().min(1),
  otNormalHours: z.coerce.number().min(0).max(744).default(0),
  otRestHours: z.coerce.number().min(0).max(744).default(0),
  otPublicHours: z.coerce.number().min(0).max(744).default(0),
  // Regular working hours override (the HRS column). Blank → null → the
  // run falls back to the value auto-computed from attendance + leave.
  // MONTHLY persists both (worked = % × expected); HOURLY only worked.
  workedHours: z
    .union([z.string(), z.null()])
    .transform((v) => coerceOptionalHours(v)),
  expectedHours: z
    .union([z.string(), z.null()])
    .transform((v) => coerceOptionalHours(v)),
  notes: z
    .union([z.string(), z.null()])
    .transform((v) => {
      if (v == null) return null
      const t = v.trim()
      return t.length > 0 ? t : null
    }),
})

export async function savePayrollAdjustmentAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = adjustmentSchema.safeParse({
    runId: formData.get("runId"),
    employeeProfileId: formData.get("employeeProfileId"),
    otNormalHours: formData.get("otNormalHours"),
    otRestHours: formData.get("otRestHours"),
    otPublicHours: formData.get("otPublicHours"),
    workedHours: formData.get("workedHours"),
    expectedHours: formData.get("expectedHours"),
    notes: formData.get("notes"),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message:
        parsed.error.issues[0]?.message ??
        "Check that all numeric fields are non-negative.",
    }
  }

  // Collect manual line items at indexes 0..50.
  const manualLineItems: ManualLineItem[] = []
  for (let i = 0; i < 50; i++) {
    const kindRaw = formData.get(`line${i}.kind`)
    const labelRaw = formData.get(`line${i}.label`)
    const amountRaw = formData.get(`line${i}.amount`)
    const categoryRaw = formData.get(`line${i}.category`)
    if (
      kindRaw == null &&
      labelRaw == null &&
      amountRaw == null &&
      categoryRaw == null
    ) {
      // No more rows — stop walking. (A user can leave gaps if they
      // deleted a middle row, but the client always re-numbers, so
      // gaps shouldn't happen in practice.)
      continue
    }
    const kindStr = String(kindRaw ?? "").trim()
    const kind: ManualLineItem["kind"] =
      kindStr === "DEDUCTION"
        ? "DEDUCTION"
        : kindStr === "REIMBURSEMENT"
          ? "REIMBURSEMENT"
          : "ALLOWANCE"
    const label = String(labelRaw ?? "").trim()
    const amountStr = String(amountRaw ?? "").trim()
    const amount = Number(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) continue
    if (label.length === 0) continue
    // Validate category against the enum. Falls back to a safe default
    // for the kind so a tampered client can't smuggle an arbitrary
    // string into the JSON column.
    const categoryStr = String(categoryRaw ?? "").trim()
    const defaultCategory =
      kind === "DEDUCTION"
        ? "deduct_salary_adjustment"
        : kind === "REIMBURSEMENT"
          ? "wages_expense_claim"
          : "allowance_standard"
    const category = payrollAdjustmentCategories.includes(categoryStr as never)
      ? categoryStr
      : defaultCategory
    // LHDN AR override — present only for AR-flagged categories where
    // admin opted to treat the line as recurring monthly remuneration.
    const treatAsRecurringRaw = formData.get(`line${i}.treatAsRecurring`)
    const treatAsRecurring =
      String(treatAsRecurringRaw ?? "").toLowerCase() === "true"
    manualLineItems.push({
      kind,
      category,
      label,
      amount,
      ...(treatAsRecurring ? { treatAsRecurring } : {}),
    })
  }

  // Collect per-row overrides on the profile's fixed adjustments.
  // Each row in the UI sets:
  //   override{i}.amount    (number, currency)
  //   override{i}.skip      ("true" / undefined)
  //   override{i}.original  (number — profile baseline)
  // We only store a row when it actually deviates from the profile.
  // Indexes refer to positions in `PayrollProfile.fixedAllowances`.
  const fixedAllowanceOverrides: FixedAllowanceOverrideMap = {}
  for (let i = 0; i < 50; i++) {
    const amountRaw = formData.get(`override${i}.amount`)
    const skipRaw = formData.get(`override${i}.skip`)
    const originalRaw = formData.get(`override${i}.original`)
    if (amountRaw == null && skipRaw == null && originalRaw == null) {
      continue
    }
    const skip = String(skipRaw ?? "").trim() === "true"
    const original = Number(String(originalRaw ?? ""))
    const amount = Number(String(amountRaw ?? ""))

    if (skip) {
      fixedAllowanceOverrides[String(i)] = { amount: null, skip: true }
      continue
    }
    // Only persist an amount override when it actually differs from
    // the profile baseline. Avoids cluttering the JSON column with
    // no-op rows.
    if (
      Number.isFinite(amount) &&
      amount >= 0 &&
      Number.isFinite(original) &&
      Math.abs(amount - original) > 0.0001
    ) {
      fixedAllowanceOverrides[String(i)] = { amount, skip: false }
    }
  }

  // Guard: refuse to save when the proposed deductions would push this
  // employee's net pay to zero or below. We recompute the one
  // employee's payslip with the in-progress adjustment (same calc the
  // run uses, incl. any active loan installment) and block on net <= 0.
  // `null` means we couldn't compute (auth/run/employee) — skip the
  // guard rather than block a legitimate save.
  try {
    const preview = await previewEmployeeNetForRun({
      runId: parsed.data.runId,
      employeeProfileId: parsed.data.employeeProfileId,
      patch: {
        otNormalHours: parsed.data.otNormalHours,
        otRestHours: parsed.data.otRestHours,
        otPublicHours: parsed.data.otPublicHours,
        workedHours: parsed.data.workedHours,
        expectedHours: parsed.data.expectedHours,
        manualLineItems,
        fixedAllowanceOverrides,
      },
    })
    if (preview && preview.netPay <= 0) {
      const fmt = (n: number) =>
        `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      return {
        status: "error",
        message: `These deductions would leave a net pay of ${fmt(
          preview.netPay,
        )} (gross ${fmt(
          preview.grossPay,
        )}). Net pay can't be zero or negative — reduce the deductions before saving.`,
      }
    }
  } catch {
    // Preview is best-effort; if it throws, fall through and let the
    // save proceed (the run-generation balance checks still apply).
  }

  try {
    await savePayrollAdjustment({
      runId: parsed.data.runId,
      employeeProfileId: parsed.data.employeeProfileId,
      patch: {
        otNormalHours: parsed.data.otNormalHours,
        otRestHours: parsed.data.otRestHours,
        otPublicHours: parsed.data.otPublicHours,
        workedHours: parsed.data.workedHours,
        expectedHours: parsed.data.expectedHours,
        notes: parsed.data.notes,
        manualLineItems,
        fixedAllowanceOverrides,
      },
    })
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not save adjustments."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  return { status: "success", message: "Adjustments saved." }
}

const clearSchema = z.object({
  runId: z.string().min(1),
  employeeProfileId: z.string().min(1),
})

export async function clearPayrollAdjustmentAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = clearSchema.safeParse({
    runId: formData.get("runId"),
    employeeProfileId: formData.get("employeeProfileId"),
  })
  if (!parsed.success) {
    return { status: "error", message: "Missing run or employee id." }
  }

  try {
    await clearPayrollAdjustment(parsed.data)
  } catch (err) {
    return {
      status: "error",
      message:
        safeErrorMessage(err, "Could not clear adjustments."),
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  return { status: "success", message: "Adjustments cleared." }
}

/**
 * Lazy-load the data the per-employee adjustment form needs to render
 * inside the modal dialog on the run detail page. Mirrors the page-
 * data service but called from the client (via server action) when
 * the modal opens, so we don't eagerly load every employee's
 * adjustment data when the run page first renders.
 *
 * Returns null when the session is invalid, the org doesn't match,
 * or the employee isn't on this run — the dialog renders an error
 * state in that case.
 */
export async function fetchAdjustmentForDialogAction(input: {
  runId: string
  employeeProfileId: string
}): Promise<{
  adjustment: PayrollRunAdjustmentData | null
  fixedAllowances: FixedAllowance[]
  salaryType: "MONTHLY" | "HOURLY"
  autoHours: {
    workedHours: number | null
    expectedHours: number | null
    attendancePercent: number | null
  }
  autoOt: {
    normalHours: number
    restHours: number
    publicHours: number
  }
  loans: Array<{ id: string; label: string; amount: number }>
} | null> {
  const data = await getPayrollAdjustmentPageData(input)
  if (!data) return null
  return {
    adjustment: data.adjustment,
    fixedAllowances: data.fixedAllowances,
    salaryType: data.employee.salaryType,
    autoHours: data.autoHours,
    autoOt: data.autoOt,
    loans: data.loans,
  }
}
