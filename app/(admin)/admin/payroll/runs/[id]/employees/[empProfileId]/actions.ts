"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import type { BaseFormState } from "@/lib/form-state"
import {
  clearPayrollAdjustment,
  savePayrollAdjustment,
} from "@/modules/payroll/application/services/payroll-run.service"
import type { ManualLineItem } from "@/modules/payroll/domain/runs"

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

const adjustmentSchema = z.object({
  runId: z.string().min(1),
  employeeProfileId: z.string().min(1),
  otNormalHours: z.coerce.number().min(0).max(744).default(0),
  otRestHours: z.coerce.number().min(0).max(744).default(0),
  otPublicHours: z.coerce.number().min(0).max(744).default(0),
  unpaidLeaveDeduction: z.coerce.number().min(0).max(1_000_000).default(0),
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
    unpaidLeaveDeduction: formData.get("unpaidLeaveDeduction"),
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
    if (kindRaw == null && labelRaw == null && amountRaw == null) {
      // No more rows — stop walking. (A user can leave gaps if they
      // deleted a middle row, but the client always re-numbers, so
      // gaps shouldn't happen in practice.)
      continue
    }
    const kind =
      String(kindRaw ?? "").trim() === "DEDUCTION" ? "DEDUCTION" : "ALLOWANCE"
    const label = String(labelRaw ?? "").trim()
    const amountStr = String(amountRaw ?? "").trim()
    const amount = Number(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) continue
    if (label.length === 0) continue
    manualLineItems.push({ kind, label, amount })
  }

  try {
    await savePayrollAdjustment({
      runId: parsed.data.runId,
      employeeProfileId: parsed.data.employeeProfileId,
      patch: {
        otNormalHours: parsed.data.otNormalHours,
        otRestHours: parsed.data.otRestHours,
        otPublicHours: parsed.data.otPublicHours,
        unpaidLeaveDeduction: parsed.data.unpaidLeaveDeduction,
        notes: parsed.data.notes,
        manualLineItems,
      },
    })
  } catch (err) {
    return {
      status: "error",
      message:
        err instanceof Error ? err.message : "Could not save adjustments.",
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
        err instanceof Error ? err.message : "Could not clear adjustments.",
    }
  }

  revalidatePath(`/admin/payroll/runs/${parsed.data.runId}`)
  redirect(`/admin/payroll/runs/${parsed.data.runId}`)
}
