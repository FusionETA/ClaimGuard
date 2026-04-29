"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requirePortalSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour) format")

const workingHoursSchema = z.object({
  start: timeSchema,
  end: timeSchema,
})

export type SetWorkingHoursState = {
  ok?: boolean
  error?: string
}

export async function setWorkingHoursAction(
  _prev: SetWorkingHoursState,
  formData: FormData,
): Promise<SetWorkingHoursState> {
  const session = await requirePortalSession("ADMIN")
  const organizationId = session.activeOrganizationId ?? session.organizationId

  if (!organizationId) {
    return { error: "Admin account is not assigned to an organisation." }
  }

  const parsed = workingHoursSchema.safeParse({
    start: formData.get("start"),
    end: formData.get("end"),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  if (parsed.data.start >= parsed.data.end) {
    return { error: "Start time must be before end time" }
  }

  await adminAttendanceService.setWorkingHours(
    organizationId,
    parsed.data.start,
    parsed.data.end,
  )

  revalidatePath("/admin/attendance")
  revalidatePath("/employee/attendance")

  return { ok: true }
}
