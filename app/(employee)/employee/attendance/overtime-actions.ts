"use server"

import { revalidatePath } from "next/cache"

import { requirePortalSession } from "@/lib/auth/session"
import { safeErrorMessage } from "@/lib/errors"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

export async function uploadOtAttachmentAction(
  approvalId: string,
  formData: FormData,
): Promise<{ ok: true; attachment: { id: string; fileName: string; fileUrl: string; mimeType: string; uploadedAt: string; kind: "JUSTIFICATION" | "EVIDENCE" } } | { error: string }> {
  const session = await requirePortalSession("EMPLOYEE")
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { error: "No file provided." }
  }
  let attachment: { id: string; fileName: string; fileUrl: string; mimeType: string; uploadedAt: string; kind: "JUSTIFICATION" | "EVIDENCE" }
  try {
    attachment = await employeeAttendanceService.addOtAttachment(session.userId, approvalId, file, "EVIDENCE")
  } catch (err) {
    return { error: safeErrorMessage(err, "Could not upload attachment.") }
  }
  revalidatePath("/employee/attendance/overtime")
  return { ok: true, attachment }
}

export async function deleteOtAttachmentAction(
  attachmentId: string,
): Promise<{ ok: true } | { error: string }> {
  const session = await requirePortalSession("EMPLOYEE")
  try {
    await employeeAttendanceService.deleteOtAttachment(session.userId, attachmentId)
  } catch (err) {
    return { error: safeErrorMessage(err, "Could not delete attachment.") }
  }
  revalidatePath("/employee/attendance/overtime")
  return { ok: true }
}
