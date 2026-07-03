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
  otSubtype: z.enum(["LATE_REPLACEMENT", "OT_OFFSET", "UNRESOLVED"]).optional().nullable(),
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
    otSubtype: formData.get("otSubtype") || null,
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
      otSubtype: parsed.data.otSubtype ?? null,
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

const bulkReviewSchema = z.object({
  approvalIds: z
    .array(z.string().min(1))
    .min(1, "Pick at least one approval to review.")
    .max(200, "Too many at once — pick fewer than 200."),
  status: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().optional().nullable(),
})

export type BulkReviewApprovalsState = {
  ok: boolean
  message: string
  succeeded: number
  failed: number
}

/**
 * Server action: review many attendance approval requests in one click.
 * Each id is reviewed independently via the same service method as the
 * single-row action — failures on one row don't roll back the others.
 * Time-overrides aren't accepted here (bulk is for the common case of
 * "approve everything as-recorded"); use the single-row dialog to edit
 * a specific row's time.
 */
export async function bulkReviewApprovalsAction(
  _prev: BulkReviewApprovalsState,
  formData: FormData,
): Promise<BulkReviewApprovalsState> {
  const session = await requirePortalSession("SUPERVISOR")

  // Client posts the ids as a JSON array under a single field, so a
  // mixed selection of any size still fits in one FormData entry.
  let parsedIds: unknown
  try {
    parsedIds = JSON.parse(String(formData.get("approvalIds") ?? "[]"))
  } catch {
    parsedIds = []
  }

  const parsed = bulkReviewSchema.safeParse({
    approvalIds: parsedIds,
    status: formData.get("status"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
      succeeded: 0,
      failed: 0,
    }
  }

  const outcomes = await Promise.allSettled(
    parsed.data.approvalIds.map((id) =>
      supervisorAttendanceService.reviewApproval(
        session.userId,
        id,
        parsed.data.status,
        { notes: parsed.data.notes ?? null, overrideEventAt: null },
      ),
    ),
  )
  const succeeded = outcomes.filter((o) => o.status === "fulfilled").length
  const failed = outcomes.length - succeeded

  revalidatePath("/employee/attendance/approvals")
  revalidatePath("/employee/attendance/team")
  revalidatePath("/admin/attendance")
  if (session.organizationId) {
    await bustAttendanceCaches({ organizationId: session.organizationId })
  }

  const verb = parsed.data.status === "APPROVED" ? "approved" : "rejected"
  const message =
    failed === 0
      ? `${verb[0]!.toUpperCase()}${verb.slice(1)} ${succeeded} approval${succeeded === 1 ? "" : "s"}.`
      : `${verb[0]!.toUpperCase()}${verb.slice(1)} ${succeeded} of ${outcomes.length} — ${failed} failed.`

  return { ok: failed === 0, message, succeeded, failed }
}
