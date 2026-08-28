"use server"

import { revalidatePath } from "next/cache"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  cancelLeaveApplication,
  decideLeaveApplication,
  editLeaveApplication,
  submitLeaveApplication,
} from "@/modules/leave/application/services/leave-application.service"
import { storeLeaveAttachment } from "@/modules/leave/infrastructure/leave-attachment-storage"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import type { LeaveDuration } from "@/modules/leave/domain/models"

async function profileIdForCurrentUser(): Promise<{
  profileId: string
  userId: string
  role: string
} | null> {
  const session = await getCurrentSession()
  if (!session) return null
  // Multi-org: resolve to the profile at the CURRENT active org so a
  // leave submission/edit doesn't leak into a different company.
  const profileId = await leaveRepository.findEmployeeProfileIdByUserId(
    session.userId,
    resolveActiveOrgId(session),
  )
  if (!profileId) return null
  return { profileId, userId: session.userId, role: session.role }
}

export async function submitLeaveAction(formData: FormData) {
  const ctx = await profileIdForCurrentUser()
  if (!ctx) return { ok: false as const, error: "Not signed in" }

  const startDate = new Date(String(formData.get("startDate") ?? ""))
  const endDate = new Date(String(formData.get("endDate") ?? ""))
  const duration = String(formData.get("duration") ?? "FULL_DAY") as LeaveDuration
  const leaveTypeId = String(formData.get("leaveTypeId") ?? "")
  const reason = String(formData.get("reason") ?? "").trim() || null

  if (!leaveTypeId) return { ok: false as const, error: "Pick a leave type" }
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { ok: false as const, error: "Invalid dates" }
  }

  // Optional attachment — empty file means the employee didn't upload one.
  let attachmentUrl: string | null = null
  let attachmentName: string | null = null
  let xeroFileId: string | null = null
  const attachmentEntry = formData.get("attachment")
  if (attachmentEntry instanceof File && attachmentEntry.size > 0) {
    try {
      const stored = await storeLeaveAttachment(attachmentEntry, ctx.profileId)
      attachmentUrl = stored.attachmentUrl
      attachmentName = stored.attachmentName
      xeroFileId = stored.xeroFileId
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Attachment upload failed",
      }
    }
  }

  const res = await submitLeaveApplication(
    {
      employeeProfileId: ctx.profileId,
      leaveTypeId,
      startDate,
      endDate,
      duration,
      reason,
      attachmentUrl,
      attachmentName,
      xeroFileId,
    },
    ctx.role,
  )
  if (!res.ok) return { ok: false as const, error: res.error }
  revalidatePath("/employee/leave")
  return {
    ok: true as const,
    status: res.status,
    totalDays: res.totalDays,
    applicationId: res.applicationId,
  }
}

export async function editLeaveAction(applicationId: string, formData: FormData) {
  const ctx = await profileIdForCurrentUser()
  if (!ctx) return { ok: false as const, error: "Not signed in" }

  const startDate = new Date(String(formData.get("startDate") ?? ""))
  const endDate = new Date(String(formData.get("endDate") ?? ""))
  const duration = String(formData.get("duration") ?? "FULL_DAY") as LeaveDuration
  const leaveTypeId = String(formData.get("leaveTypeId") ?? "")
  const reason = String(formData.get("reason") ?? "").trim() || null

  if (!leaveTypeId) return { ok: false as const, error: "Pick a leave type" }
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { ok: false as const, error: "Invalid dates" }
  }

  // Attachment handling on edit: replace only when a non-empty file is
  // uploaded. Empty input → keep existing attachment unchanged.
  let attachment:
    | { attachmentUrl: string | null; attachmentName: string | null; xeroFileId: string | null }
    | undefined = undefined
  const attachmentEntry = formData.get("attachment")
  if (attachmentEntry instanceof File && attachmentEntry.size > 0) {
    try {
      const stored = await storeLeaveAttachment(attachmentEntry, ctx.profileId)
      attachment = {
        attachmentUrl: stored.attachmentUrl,
        attachmentName: stored.attachmentName,
        xeroFileId: stored.xeroFileId,
      }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Attachment upload failed",
      }
    }
  }

  const res = await editLeaveApplication({
    applicationId,
    actorUserId: ctx.userId,
    leaveTypeId,
    startDate,
    endDate,
    duration,
    reason,
    attachment,
  })
  if (!res.ok) return res
  revalidatePath("/employee/leave")
  return { ok: true as const, totalDays: res.totalDays }
}

/// Withdraw one's own PENDING request. Ownership and the status guard
/// are enforced in the service — this only resolves the session.
export async function cancelLeaveAction(applicationId: string) {
  const ctx = await profileIdForCurrentUser()
  if (!ctx) return { ok: false as const, error: "Not signed in" }

  const res = await cancelLeaveApplication(applicationId, ctx.userId)
  if (!res.ok) return res

  revalidatePath("/employee/leave")
  return { ok: true as const }
}

export async function decideLeaveAction(
  applicationId: string,
  decision: "APPROVED" | "REJECTED",
  notes?: string,
) {
  const session = await getCurrentSession()
  if (!session) return { ok: false as const, error: "Not signed in" }
  const res = await decideLeaveApplication({
    applicationId,
    reviewerUserId: session.userId,
    decision,
    notes,
  })
  if (!res.ok) return res
  revalidatePath("/employee/leave")
  revalidatePath("/admin/leave")
  return res
}
