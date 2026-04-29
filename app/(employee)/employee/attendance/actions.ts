"use server"

import { revalidatePath } from "next/cache"

import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

export async function clockInAction() {
  const session = await requirePortalSession("EMPLOYEE")
  await employeeAttendanceService.clockIn(session.userId)
  revalidatePath("/employee/attendance")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/admin/attendance")
}

export async function clockOutAction() {
  const session = await requirePortalSession("EMPLOYEE")
  await employeeAttendanceService.clockOut(session.userId)
  revalidatePath("/employee/attendance")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/admin/attendance")
}

export async function confirmBreakAction() {
  const session = await requirePortalSession("EMPLOYEE")
  await employeeAttendanceService.confirmBreak(session.userId)
  revalidatePath("/employee/attendance")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/employee/attendance/approvals")
}
