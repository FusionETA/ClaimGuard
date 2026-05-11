"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requirePortalSession } from "@/lib/auth/session"
import { bustAttendanceCaches } from "@/lib/cache-invalidation"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

const reviewSchema = z.object({
  approvalId: z.string().min(1),
  status: z.enum(["APPROVED", "REJECTED"]),
  // <input type="datetime-local"> → "YYYY-MM-DDTHH:MM". Empty string is
  // treated as "no override" so existing UIs keep working unchanged.
  overrideEventAt: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
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
    overrideEventAt: formData.get("overrideEventAt"),
    notes: formData.get("notes"),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  let overrideEventAt: Date | null = null
  if (parsed.data.overrideEventAt) {
    const d = new Date(parsed.data.overrideEventAt)
    if (!Number.isNaN(d.getTime())) overrideEventAt = d
  }

  await supervisorAttendanceService.reviewApproval(
    session.userId,
    parsed.data.approvalId,
    parsed.data.status,
    {
      notes: parsed.data.notes ?? null,
      overrideEventAt,
    },
  )

  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/admin/attendance")

  // Approval review affects org-wide pending-approvals + the requesting
  // employee's per-user OT records. We don't have the requester's
  // userId here without an extra query, so we sweep the org level —
  // per-user keys expire on TTL anyway.
  if (session.organizationId) {
    await bustAttendanceCaches({ organizationId: session.organizationId })
  }

  return { ok: true }
}
