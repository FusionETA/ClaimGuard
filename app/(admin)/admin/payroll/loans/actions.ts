"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { safeErrorMessage } from "@/lib/errors"
import type { BaseFormState } from "@/lib/form-state"
import {
  cancelEmployeeLoan,
  createEmployeeLoan,
  editEmployeeLoan,
} from "@/modules/payroll/application/services/loan.service"

/** Collect repeated `installment{i}` fields (0-based, contiguous). */
function collectSchedule(formData: FormData): number[] {
  const out: number[] = []
  for (let i = 0; i < 240; i++) {
    const raw = formData.get(`installment${i}`)
    if (raw == null) break
    out.push(Number(String(raw)))
  }
  return out
}

const createSchema = z
  .object({
    employeeProfileId: z.string().min(1, "Pick an employee."),
    principalAmount: z.coerce.number().positive("Loan amount must be greater than zero."),
    mode: z.enum(["FIXED", "CUSTOM"]),
    installmentCount: z.coerce.number().int().positive().optional(),
    startYear: z.coerce.number().int().min(2000).max(2100),
    startMonth: z.coerce.number().int().min(1).max(12),
    notes: z
      .union([z.string(), z.null()])
      .transform((v) => {
        if (v == null) return null
        const t = v.trim()
        return t.length > 0 ? t : null
      }),
  })
  .refine(
    (d) => (d.mode === "FIXED" ? d.installmentCount != null : true),
    { message: "Enter the number of installments.", path: ["installmentCount"] },
  )

export async function createLoanAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = createSchema.safeParse({
    employeeProfileId: formData.get("employeeProfileId"),
    principalAmount: formData.get("principalAmount"),
    mode: formData.get("mode"),
    installmentCount: formData.get("installmentCount") || undefined,
    startYear: formData.get("startYear"),
    startMonth: formData.get("startMonth"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the loan details.",
    }
  }

  // CUSTOM submits a per-month schedule via repeated installment fields.
  const schedule = collectSchedule(formData)

  try {
    await createEmployeeLoan({
      employeeProfileId: parsed.data.employeeProfileId,
      principalAmount: parsed.data.principalAmount,
      mode: parsed.data.mode,
      installmentCount: parsed.data.installmentCount ?? null,
      schedule: schedule.length > 0 ? schedule : undefined,
      startYear: parsed.data.startYear,
      startMonth: parsed.data.startMonth,
      notes: parsed.data.notes,
    })
  } catch (err) {
    return { status: "error", message: safeErrorMessage(err, "Could not create the loan.") }
  }

  revalidatePath("/admin/payroll/loans")
  return { status: "success", message: "Loan created." }
}

const editSchema = z.object({
  loanId: z.string().min(1),
  // Full-edit fields (used when no installment has been paid yet).
  principalAmount: z.coerce.number().positive().optional(),
  mode: z.enum(["FIXED", "CUSTOM"]).optional(),
  installmentCount: z.coerce.number().int().positive().optional(),
  installmentAmount: z.coerce.number().positive().optional(),
  startYear: z.coerce.number().int().min(2000).max(2100).optional(),
  startMonth: z.coerce.number().int().min(1).max(12).optional(),
  notes: z
    .union([z.string(), z.null()])
    .transform((v) => {
      if (v == null) return null
      const t = v.trim()
      return t.length > 0 ? t : null
    }),
})

export async function editLoanAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = editSchema.safeParse({
    loanId: formData.get("loanId"),
    principalAmount: formData.get("principalAmount") || undefined,
    mode: formData.get("mode") || undefined,
    installmentCount: formData.get("installmentCount") || undefined,
    installmentAmount: formData.get("installmentAmount") || undefined,
    startYear: formData.get("startYear") || undefined,
    startMonth: formData.get("startMonth") || undefined,
    notes: formData.get("notes"),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the loan details.",
    }
  }

  // A started CUSTOM loan submits its edited schedule as repeated
  // `installment{i}` fields. Collect them in order.
  const schedule: number[] = []
  for (let i = 0; i < 240; i++) {
    const raw = formData.get(`installment${i}`)
    if (raw == null) break
    const n = Number(String(raw))
    if (!Number.isFinite(n)) {
      return { status: "error", message: "Installment amounts must be numbers." }
    }
    schedule.push(n)
  }

  const d = parsed.data
  const full =
    d.principalAmount != null && d.mode && d.startYear != null && d.startMonth != null
      ? {
          principalAmount: d.principalAmount,
          mode: d.mode,
          installmentCount: d.installmentCount ?? null,
          installmentAmount: d.installmentAmount ?? null,
          startYear: d.startYear,
          startMonth: d.startMonth,
        }
      : undefined

  try {
    await editEmployeeLoan({
      loanId: d.loanId,
      full,
      schedule: schedule.length > 0 ? schedule : undefined,
      notes: d.notes,
    })
  } catch (err) {
    return { status: "error", message: safeErrorMessage(err, "Could not update the loan.") }
  }

  revalidatePath("/admin/payroll/loans")
  return { status: "success", message: "Loan updated." }
}

const cancelSchema = z.object({ loanId: z.string().min(1) })

export async function cancelLoanAction(
  _prev: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const parsed = cancelSchema.safeParse({ loanId: formData.get("loanId") })
  if (!parsed.success) {
    return { status: "error", message: "Missing loan id." }
  }
  try {
    await cancelEmployeeLoan(parsed.data.loanId)
  } catch (err) {
    return { status: "error", message: safeErrorMessage(err, "Could not cancel the loan.") }
  }
  revalidatePath("/admin/payroll/loans")
  return { status: "success", message: "Loan cancelled." }
}
