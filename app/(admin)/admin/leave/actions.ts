"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { applyLeaveOnBehalfOfEmployee } from "@/modules/leave/application/services/leave-application.service"

/**
 * Admin-only: file a leave application on behalf of an employee.
 *
 * Used when an employee tells the admin verbally / over chat that they
 * need a day off and the admin keys it in rather than asking the
 * employee to log into the portal. Lands as APPROVED (skips supervisor
 * approval — the admin already has authority) and decrements the
 * employee's entitlement balance.
 *
 * Returns a plain `{ ok, message }` so the caller can render an inline
 * toast via the useTransition + useToast pattern (mirrors the
 * sync-claim action shape — no useActionState here because the form
 * lives in a dialog and we want to close it on success).
 */
const schema = z.object({
  employeeProfileId: z.string().min(1, "Pick an employee."),
  leaveTypeId: z.string().min(1, "Pick a leave type."),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date."),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date."),
  duration: z.enum(["FULL_DAY", "MORNING", "AFTERNOON"]).default("FULL_DAY"),
  reason: z.string().trim().max(2000).optional(),
})

export async function applyLeaveOnBehalfAction(input: {
  employeeProfileId: string
  leaveTypeId: string
  /// yyyy-mm-dd
  startDate: string
  /// yyyy-mm-dd
  endDate: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  reason?: string
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organisation." }

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // Parse the yyyy-mm-dd to a UTC date so the working-days math stays
  // consistent with the employee-self path (which receives Dates the
  // same way upstream).
  const startDate = parseIsoDate(parsed.data.startDate)
  const endDate = parseIsoDate(parsed.data.endDate)
  if (!startDate || !endDate) {
    return { ok: false, message: "Invalid date format." }
  }

  const result = await applyLeaveOnBehalfOfEmployee({
    adminUserId: session.userId,
    payload: {
      employeeProfileId: parsed.data.employeeProfileId,
      leaveTypeId: parsed.data.leaveTypeId,
      startDate,
      endDate,
      duration: parsed.data.duration,
      reason: parsed.data.reason ?? null,
    },
  })
  if (!result.ok) {
    return { ok: false, message: result.error }
  }

  revalidatePath("/admin/leave")
  revalidatePath("/admin/leave/balances")
  revalidatePath("/employee/leave")
  return {
    ok: true,
    message: `Applied ${result.totalDays} day(s) of leave on behalf of the employee.`,
  }
}

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d))
}
