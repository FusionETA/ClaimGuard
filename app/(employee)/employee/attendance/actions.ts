"use server"

import { revalidatePath } from "next/cache"

import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

export type ClockInState = { error?: string }

function revalidateAll() {
  revalidatePath("/employee")
  revalidatePath("/employee/attendance")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/admin/attendance")
}

export async function clockInAction(
  _prev: ClockInState,
  formData: FormData,
): Promise<ClockInState> {
  const session = await requirePortalSession("EMPLOYEE")
  const projectId = String(formData.get("projectId") ?? "")
  if (!projectId) return { error: "Pick a project before clocking in." }
  try {
    await employeeAttendanceService.clockIn(session.userId, projectId)
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not clock in" }
  }
  revalidateAll()
  return {}
}

export async function clockOutAction() {
  const session = await requirePortalSession("EMPLOYEE")
  await employeeAttendanceService.clockOut(session.userId)
  revalidateAll()
}

export async function confirmBreakAction() {
  const session = await requirePortalSession("EMPLOYEE")
  await employeeAttendanceService.confirmBreak(session.userId)
  revalidateAll()
}
