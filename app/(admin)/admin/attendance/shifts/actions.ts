"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { safeErrorMessage } from "@/lib/errors"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

/**
 * Server actions for admin shift CRUD (Phase 4).
 *
 * Every action:
 *   - Requires an ADMIN portal session (rejects supervisor / employee)
 *   - Resolves the admin's active org id
 *   - Validates form data with a small zod schema
 *   - Delegates to `adminAttendanceService.*`
 *   - Revalidates /admin/attendance/shifts on success
 *
 * Return shape matches the { ok, error?, code? } convention already used
 * by the OT admin actions in Phase 9.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

// Comma-separated ISO weekday numbers, 1-7. Duplicates and out-of-
// range values are rejected before we send anything to the repo.
const WORKING_DAYS_CSV = /^[1-7](,[1-7])*$/

const shiftInputSchema = z.object({
  projectId: z.string().min(1, "Pick a project."),
  name: z.string().trim().min(1, "Name is required.").max(80),
  startTime: z
    .string()
    .regex(HHMM, "Start time must be HH:MM (24h)."),
  endTime: z.string().regex(HHMM, "End time must be HH:MM (24h)."),
  workingDays: z
    .string()
    .transform((v) => v.trim())
    .refine(
      (v) => v.length === 0 || WORKING_DAYS_CSV.test(v),
      "Working days must be a comma-separated list of 1..7 (Mon..Sun).",
    )
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .default(null),
  lunchBreakMin: z.coerce
    .number()
    .int("Lunch break must be a whole number.")
    .min(0, "Lunch break can't be negative.")
    .max(240, "Lunch break > 240 minutes doesn't make sense — check the value."),
  isDefault: z.boolean().default(false),
})

type ShiftActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

function pickField(err: z.ZodError): Record<string, string> {
  const flat = err.flatten().fieldErrors as Record<string, string[] | undefined>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(flat)) {
    const first = v?.[0]
    if (first) out[k] = first
  }
  return out
}

export async function createShiftAction(
  formData: FormData,
): Promise<ShiftActionResult> {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, error: "No active organisation." }

  const parsed = shiftInputSchema.safeParse({
    projectId: formData.get("projectId"),
    name: formData.get("name"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    workingDays: formData.get("workingDays") ?? "",
    lunchBreakMin: formData.get("lunchBreakMin"),
    isDefault: formData.get("isDefault") === "on",
  })
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: pickField(parsed.error),
    }
  }

  try {
    await adminAttendanceService.createShift({
      orgId,
      projectId: parsed.data.projectId,
      name: parsed.data.name,
      startTime: parsed.data.startTime,
      endTime: parsed.data.endTime,
      workingDays: parsed.data.workingDays,
      lunchBreakMin: parsed.data.lunchBreakMin,
      isDefault: parsed.data.isDefault,
    })
  } catch (err) {
    return {
      ok: false,
      error: safeErrorMessage(err, "Couldn't create shift right now."),
    }
  }

  revalidatePath("/admin/attendance/shifts")
  return { ok: true }
}

export async function updateShiftAction(
  shiftId: string,
  formData: FormData,
): Promise<ShiftActionResult> {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, error: "No active organisation." }
  if (!shiftId) return { ok: false, error: "Missing shift id." }

  // Same schema — the project is fixed on edit but we still accept it
  // to reuse the same validator without projectId-specific
  // branching. It just isn't threaded through to the update payload.
  const parsed = shiftInputSchema.safeParse({
    projectId: formData.get("projectId") ?? "_placeholder",
    name: formData.get("name"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    workingDays: formData.get("workingDays") ?? "",
    lunchBreakMin: formData.get("lunchBreakMin"),
    isDefault: formData.get("isDefault") === "on",
  })
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: pickField(parsed.error),
    }
  }

  try {
    await adminAttendanceService.updateShift({
      orgId,
      id: shiftId,
      name: parsed.data.name,
      startTime: parsed.data.startTime,
      endTime: parsed.data.endTime,
      workingDays: parsed.data.workingDays,
      lunchBreakMin: parsed.data.lunchBreakMin,
      isDefault: parsed.data.isDefault,
    })
  } catch (err) {
    return {
      ok: false,
      error: safeErrorMessage(err, "Couldn't update shift right now."),
    }
  }

  revalidatePath("/admin/attendance/shifts")
  return { ok: true }
}

export async function deleteShiftAction(
  shiftId: string,
): Promise<ShiftActionResult> {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, error: "No active organisation." }
  if (!shiftId) return { ok: false, error: "Missing shift id." }

  const result = await adminAttendanceService.deleteShift({
    orgId,
    id: shiftId,
  })
  if (result.ok === false) {
    if (result.code === "NOT_FOUND") {
      return { ok: false, error: "That shift no longer exists." }
    }
    if (result.code === "IN_USE") {
      return {
        ok: false,
        error: `Can't delete — ${result.assignedMemberCount} employee${
          result.assignedMemberCount === 1 ? "" : "s"
        } still assigned to this shift. Reassign them first.`,
      }
    }
  }

  revalidatePath("/admin/attendance/shifts")
  return { ok: true }
}

export async function setDefaultShiftAction(
  shiftId: string,
): Promise<ShiftActionResult> {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, error: "No active organisation." }
  if (!shiftId) return { ok: false, error: "Missing shift id." }

  try {
    await adminAttendanceService.setDefaultShift({ orgId, id: shiftId })
  } catch (err) {
    return {
      ok: false,
      error: safeErrorMessage(err, "Couldn't set default right now."),
    }
  }

  revalidatePath("/admin/attendance/shifts")
  return { ok: true }
}
