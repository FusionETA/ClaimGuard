"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

const reviewSchema = z.object({
  approvalId: z.string().min(1),
  status: z.enum(["APPROVED", "REJECTED"]),
})

export type ReviewApprovalState = {
  ok?: boolean
  error?: string
}

export async function reviewApprovalAction(
  _prev: ReviewApprovalState,
  formData: FormData,
): Promise<ReviewApprovalState> {
  const session = await requirePortalSession("SUPERVISOR")

  const parsed = reviewSchema.safeParse({
    approvalId: formData.get("approvalId"),
    status: formData.get("status"),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  await supervisorAttendanceService.reviewApproval(
    session.userId,
    parsed.data.approvalId,
    parsed.data.status,
  )

  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/admin/attendance")

  return { ok: true }
}
