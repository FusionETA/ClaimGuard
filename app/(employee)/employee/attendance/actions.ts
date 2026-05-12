"use server"

import { revalidatePath } from "next/cache"

import { requirePortalSession } from "@/lib/auth/session"
import { bustAttendanceCaches } from "@/lib/cache-invalidation"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

export type ClockInState = { error?: string }

/**
 * Bust both Next.js render cache and Redis attendance caches after a
 * clock-in / clock-out / break event. Pass the employee's userId so we
 * can target their per-user keys precisely; orgId is optional and
 * widens the bust to the org-level admin caches when provided.
 */
async function revalidateAll(args: {
  userId: string
  organizationId?: string
}) {
  revalidatePath("/employee")
  revalidatePath("/employee/attendance")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/admin/attendance")
  await bustAttendanceCaches({
    employeeUserId: args.userId,
    organizationId: args.organizationId,
  })
}

function parseCoords(
  formData: FormData | undefined,
): { lat: number; lng: number } | undefined {
  if (!formData) return undefined
  const latRaw = formData.get("lat")
  const lngRaw = formData.get("lng")
  const lat = typeof latRaw === "string" ? parseFloat(latRaw) : NaN
  const lng = typeof lngRaw === "string" ? parseFloat(lngRaw) : NaN
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined
}

function parseNotes(formData: FormData | undefined): string | undefined {
  if (!formData) return undefined
  const raw = formData.get("notes")
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  return trimmed ? trimmed : undefined
}

function parseSelfie(formData: FormData | undefined): string | undefined {
  if (!formData) return undefined
  const raw = formData.get("selfie")
  if (typeof raw !== "string") return undefined
  // Expect a data URL like "data:image/jpeg;base64,…". Anything else is
  // treated as missing.
  return raw.startsWith("data:image/") ? raw : undefined
}

export async function clockInAction(
  _prev: ClockInState,
  formData: FormData,
): Promise<ClockInState> {
  const session = await requirePortalSession("EMPLOYEE")
  const projectId = String(formData.get("projectId") ?? "")
  if (!projectId) return { error: "Pick a project before clocking in." }
  const coords = parseCoords(formData)
  const notes = parseNotes(formData)
  const selfie = parseSelfie(formData)
  try {
    await employeeAttendanceService.clockIn(
      session.userId,
      projectId,
      coords,
      notes,
      selfie,
    )
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not clock in" }
  }
  await revalidateAll({
    userId: session.userId,
    organizationId: session.organizationId,
  })
  return {}
}

export type ClockOutSummary = {
  recordId: string
  /** ISO strings — null when missing. */
  timeIn: string | null
  timeOut: string | null
  /** Worked minutes (excluding breaks). */
  durationMin: number | null
  /** Total break minutes taken today. */
  breakMin: number
  project: string | null
  location: string | null
  lateByMin: number | null
  /** System-captured off-site context (read-only here). */
  notes: string | null
  /** Employee's adjustment-request remark (editable in the popup). */
  remark: string | null
}

export type ClockOutResult = {
  ok?: boolean
  error?: string
  summary?: ClockOutSummary
}

export async function clockOutAction(
  formData?: FormData,
): Promise<ClockOutResult> {
  const session = await requirePortalSession("EMPLOYEE")
  const coords = parseCoords(formData)
  const notes = parseNotes(formData)
  try {
    await employeeAttendanceService.clockOut(session.userId, coords, notes)
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not clock out" }
  }
  await revalidateAll({
    userId: session.userId,
    organizationId: session.organizationId,
  })
  // Read back today's record + break totals so the client can show the
  // post-clock-out summary dialog without an extra round-trip.
  const dashboard = await employeeAttendanceService.getEmployeeDashboard(
    session.userId,
  )
  const today = dashboard.today
  if (!today) {
    return { ok: true }
  }
  return {
    ok: true,
    summary: {
      recordId: today.id,
      timeIn: today.timeIn,
      timeOut: today.timeOut,
      durationMin: today.durationMin,
      breakMin: today.breakMin,
      project: today.project,
      location: today.location,
      lateByMin: today.lateByMin,
      notes: today.notes,
      remark: today.remark,
    },
  }
}

export async function startBreakAction(formData?: FormData) {
  const session = await requirePortalSession("EMPLOYEE")
  const coords = parseCoords(formData)
  const notes = parseNotes(formData)
  await employeeAttendanceService.startBreak(session.userId, coords, notes)
  await revalidateAll({
    userId: session.userId,
    organizationId: session.organizationId,
  })
}

export async function endBreakAction(formData?: FormData) {
  const session = await requirePortalSession("EMPLOYEE")
  const coords = parseCoords(formData)
  const notes = parseNotes(formData)
  await employeeAttendanceService.endBreak(session.userId, coords, notes)
  await revalidateAll({
    userId: session.userId,
    organizationId: session.organizationId,
  })
}

export type UpdateRemarkState = { ok?: boolean; error?: string }

/**
 * Updates the employee's adjustment-request remark
 * (`AttendanceRecord.remark`) on their current-day record. The repo
 * layer enforces "today only" and writes an audit row to
 * AttendanceEditLog. Distinct from `AttendanceRecord.notes`, which holds
 * system-captured off-site context and is not editable here.
 */
export async function updateTodayRemarkAction(
  _prev: UpdateRemarkState,
  formData: FormData,
): Promise<UpdateRemarkState> {
  const session = await requirePortalSession("EMPLOYEE")
  const recordId = String(formData.get("recordId") ?? "")
  if (!recordId) return { error: "No record to update." }
  const rawRemark = formData.get("remark") ?? formData.get("notes")
  const remark = typeof rawRemark === "string" ? rawRemark : ""
  try {
    await employeeAttendanceService.updateTodayRemark(
      session.userId,
      recordId,
      remark,
    )
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not save remark",
    }
  }
  await revalidateAll({
    userId: session.userId,
    organizationId: session.organizationId,
  })
  return { ok: true }
}
