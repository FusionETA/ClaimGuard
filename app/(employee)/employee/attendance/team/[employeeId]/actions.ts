"use server"

import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"
import { safeErrorMessage } from "@/lib/errors"

import { redirect } from "next/navigation"

import {
  getCurrentSession,
  resolveActiveOrgId,
} from "@/lib/auth/session"
import { bustAttendanceCaches } from "@/lib/cache-invalidation"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export type OverrideAttendanceState = { ok?: boolean; error?: string }

export type EditSessionBreak = {
  id?: string
  startedAt: string // ISO
  endedAt: string | null // ISO or null
}

export type EditSessionInput = {
  recordId: string
  employeeId: string
  timeIn: string | null // ISO, or "__CLEAR__" to clear, or null to leave unchanged
  timeOut: string | null
  breaks: EditSessionBreak[]
  reason: string
}

export type EditSessionResult = { ok?: boolean; error?: string }

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
  if (session.role !== "SUPERVISOR" && !isAdminRole(session.role)) {
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
      const employeeOrgId =
        await attendanceRepository.getOrganizationIdForUser(employeeId)
      await adminAttendanceService.overrideAttendanceTimes(session.userId, {
        attendanceRecordId: recordId,
        employeeOrgId,
        adminOrgId: resolveActiveOrgId(session) ?? null,
        timeIn,
        timeOut,
        reason,
      })
    }
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Could not save changes."),
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

/**
 * Loads the current BreakSession rows for a record so the session editor
 * can pre-populate the dialog. Authorisation: supervisor of the
 * employee, or admin in the employee's org.
 */
export async function loadSessionBreaksAction(
  recordId: string,
  employeeId: string,
): Promise<{
  breaks?: Array<{ id: string; startedAt: string; endedAt: string | null }>
  error?: string
}> {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (session.role !== "SUPERVISOR" && !isAdminRole(session.role)) {
    return { error: "Only supervisors or admins can view session details." }
  }
  if (session.role === "SUPERVISOR") {
    try {
      await attendanceRepository.assertSupervisorCanEditEmployee(
        session.userId,
        employeeId,
      )
    } catch (err) {
      return {
        error: safeErrorMessage(err, "Not authorised."),
      }
    }
  }
  const rows = await attendanceRepository.getBreakSessionsForRecord(recordId)
  return {
    breaks: rows.map((b) => ({
      id: b.id,
      startedAt: b.startedAt.toISOString(),
      endedAt: b.endedAt ? b.endedAt.toISOString() : null,
    })),
  }
}

const CLEAR_SENTINEL = "__CLEAR__"

function parseEditInput(value: string | null): Date | null | undefined {
  if (value === null) return undefined
  if (value === CLEAR_SENTINEL) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Atomic-from-the-caller's-POV save for an entire attendance session:
 * adjusts clock-in / clock-out and any combination of break edits in
 * one call. The repo writes one audit log row per change; durationMin
 * is recomputed at each step.
 */
export async function editSessionAction(
  input: EditSessionInput,
): Promise<EditSessionResult> {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (session.role !== "SUPERVISOR" && !isAdminRole(session.role)) {
    return { error: "Only supervisors or admins can edit attendance." }
  }
  const reason = input.reason.trim()
  if (!reason) return { error: "Please add a reason for these changes." }

  const timeIn = parseEditInput(input.timeIn)
  const timeOut = parseEditInput(input.timeOut)

  const breaks: Array<{
    id?: string
    startedAt: Date
    endedAt: Date | null
  }> = []
  for (const b of input.breaks) {
    const started = new Date(b.startedAt)
    if (Number.isNaN(started.getTime())) {
      return { error: "One of the break start times is invalid." }
    }
    let ended: Date | null = null
    if (b.endedAt) {
      const e = new Date(b.endedAt)
      if (Number.isNaN(e.getTime())) {
        return { error: "One of the break end times is invalid." }
      }
      if (e.getTime() < started.getTime()) {
        return { error: "Break end must be after break start." }
      }
      ended = e
    }
    breaks.push({ id: b.id, startedAt: started, endedAt: ended })
  }

  if (timeIn instanceof Date && timeOut instanceof Date && timeIn > timeOut) {
    return { error: "Clock-in must be earlier than clock-out." }
  }

  // Admin scoping: ensure the target employee is in the admin's active org.
  if (isAdminRole(session.role)) {
    const employeeOrg = await attendanceRepository.getOrganizationIdForUser(
      input.employeeId,
    )
    const adminOrg = resolveActiveOrgId(session) ?? null
    if (adminOrg && employeeOrg && employeeOrg !== adminOrg) {
      return { error: "Employee is not in your organisation." }
    }
  }

  try {
    await supervisorAttendanceService.editSession(session.userId, {
      attendanceRecordId: input.recordId,
      employeeId: input.employeeId,
      timeIn,
      timeOut,
      breaks,
      reason,
      editorRole: isAdminRole(session.role) ? "ADMIN" : "SUPERVISOR",
    })
  } catch (err) {
    return { error: safeErrorMessage(err, "Could not save.") }
  }

  revalidatePath(`/employee/attendance/team/${input.employeeId}`)
  revalidatePath("/employee/attendance/team")
  revalidatePath("/admin/attendance")
  revalidatePath("/employee/attendance/history")
  await bustAttendanceCaches({
    employeeUserId: input.employeeId,
    organizationId: session.organizationId,
  })
  return { ok: true }
}
