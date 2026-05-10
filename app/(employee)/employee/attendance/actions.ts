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

export async function clockOutAction(formData?: FormData) {
  const session = await requirePortalSession("EMPLOYEE")
  const coords = parseCoords(formData)
  const notes = parseNotes(formData)
  await employeeAttendanceService.clockOut(session.userId, coords, notes)
  await revalidateAll({
    userId: session.userId,
    organizationId: session.organizationId,
  })
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
