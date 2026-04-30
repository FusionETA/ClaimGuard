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

export async function clockInAction(
  _prev: ClockInState,
  formData: FormData,
): Promise<ClockInState> {
  const session = await requirePortalSession("EMPLOYEE")
  const projectId = String(formData.get("projectId") ?? "")
  if (!projectId) return { error: "Pick a project before clocking in." }
  const coords = parseCoords(formData)
  console.log(
    "[clockInAction] employee=%s project=%s coords=%o",
    session.userId,
    projectId,
    coords,
  )
  try {
    await employeeAttendanceService.clockIn(session.userId, projectId, coords)
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not clock in" }
  }
  revalidateAll()
  return {}
}

export async function clockOutAction(formData?: FormData) {
  const session = await requirePortalSession("EMPLOYEE")
  const coords = parseCoords(formData)
  await employeeAttendanceService.clockOut(session.userId, coords)
  revalidateAll()
}

export async function confirmBreakAction(formData?: FormData) {
  const session = await requirePortalSession("EMPLOYEE")
  const coords = parseCoords(formData)
  await employeeAttendanceService.confirmBreak(session.userId, coords)
  revalidateAll()
}
