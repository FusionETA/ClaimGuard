"use server"

import { revalidatePath } from "next/cache"

import { redirect } from "next/navigation"

import {
  getCurrentSession,
  resolveActiveOrgId,
} from "@/lib/auth/session"
import { bustAttendanceCaches } from "@/lib/cache-invalidation"
import { getPrismaClient } from "@/lib/prisma"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export type OverrideAttendanceState = { ok?: boolean; error?: string }

function parseLocalDateTime(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== "string" || value.length === 0) return null
  // <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" without a TZ.
  // Treat it as local time on the server; that matches how clock-in
  // timestamps are captured elsewhere.
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Supervisor (or admin) manual overwrite of an AttendanceRecord's
 * clock-in and/or clock-out timestamps. Accepts ISO local datetime
 * strings ("YYYY-MM-DDTHH:MM") from a <input type="datetime-local"> as
 * well as an optional `reason`. Either timestamp may be omitted to
 * leave it unchanged; pass the literal string "null" to clear.
 */
export async function overrideAttendanceAction(
  _prev: OverrideAttendanceState,
  formData: FormData,
): Promise<OverrideAttendanceState> {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (session.role !== "SUPERVISOR" && session.role !== "ADMIN") {
    return { error: "Only supervisors or admins can edit attendance." }
  }

  const recordId = String(formData.get("recordId") ?? "")
  const employeeId = String(formData.get("employeeId") ?? "")
  if (!recordId || !employeeId) {
    return { error: "Missing record." }
  }

  const timeInRaw = formData.get("timeIn")
  const timeOutRaw = formData.get("timeOut")
  const reasonRaw = formData.get("reason")
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : null

  // Three states per field: untouched (undefined), explicit clear ("null"),
  // explicit value. Use a sentinel checkbox `clearTimeIn` / `clearTimeOut`
  // from the dialog UI so the empty string from a cleared input doesn't
  // accidentally null the column.
  const clearTimeIn = formData.get("clearTimeIn") === "1"
  const clearTimeOut = formData.get("clearTimeOut") === "1"
  const timeIn: Date | null | undefined = clearTimeIn
    ? null
    : parseLocalDateTime(timeInRaw) ?? undefined
  const timeOut: Date | null | undefined = clearTimeOut
    ? null
    : parseLocalDateTime(timeOutRaw) ?? undefined

  if (timeIn === undefined && timeOut === undefined) {
    return { error: "Enter a new clock-in or clock-out time." }
  }
  if (
    timeIn instanceof Date &&
    timeOut instanceof Date &&
    timeIn.getTime() > timeOut.getTime()
  ) {
    return { error: "Clock-in must be earlier than clock-out." }
  }

  try {
    if (session.role === "SUPERVISOR") {
      await supervisorAttendanceService.overrideAttendanceTimes(
        session.userId,
        { attendanceRecordId: recordId, employeeId, timeIn, timeOut, reason },
      )
    } else {
      const prisma = getPrismaClient()
      if (!prisma) return { error: "Database is not configured." }
      const employee = await prisma.user.findUnique({
        where: { id: employeeId },
        select: { organizationId: true },
      })
      await adminAttendanceService.overrideAttendanceTimes(session.userId, {
        attendanceRecordId: recordId,
        employeeOrgId: employee?.organizationId ?? null,
        adminOrgId: resolveActiveOrgId(session) ?? null,
        timeIn,
        timeOut,
        reason,
      })
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not save changes.",
    }
  }

  revalidatePath(`/employee/attendance/team/${employeeId}`)
  revalidatePath("/employee/attendance/team")
  revalidatePath("/admin/attendance")
  revalidatePath("/employee/attendance/history")
  await bustAttendanceCaches({
    employeeUserId: employeeId,
    organizationId: session.organizationId,
  })

  return { ok: true }
}
