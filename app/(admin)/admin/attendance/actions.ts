"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustAttendanceCaches } from "@/lib/cache-invalidation"
import { getPrismaClient } from "@/lib/prisma"
import { deleteXeroFile } from "@/lib/xero"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

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
  const organizationId = resolveActiveOrgId(session)

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

  // Working hours change affects every employee's clock-in math, so we
  // sweep the org-level attendance keys. Per-user keys expire on TTL —
  // we don't iterate every employee here.
  await bustAttendanceCaches({ organizationId })

  return { ok: true }
}

export type SelfieStorageStats = {
  total: number
  oldest: string | null
  newest: string | null
}

/// Read-only summary of how many clock-in selfies are currently held in
/// Xero for this org and what date range they span. Drives the
/// "Selfie storage" card on the admin attendance page.
export async function loadSelfieStorageStatsAction(): Promise<SelfieStorageStats> {
  const session = await requirePortalSession("ADMIN")
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { total: 0, oldest: null, newest: null }

  const prisma = getPrismaClient()
  if (!prisma) return { total: 0, oldest: null, newest: null }

  const [total, oldest, newest] = await Promise.all([
    prisma.attendanceRecord.count({
      where: {
        xeroSelfieFileId: { not: null },
        employee: { organizationId },
      },
    }),
    prisma.attendanceRecord.findFirst({
      where: {
        xeroSelfieFileId: { not: null },
        employee: { organizationId },
      },
      orderBy: { selfieUploadedAt: "asc" },
      select: { selfieUploadedAt: true },
    }),
    prisma.attendanceRecord.findFirst({
      where: {
        xeroSelfieFileId: { not: null },
        employee: { organizationId },
      },
      orderBy: { selfieUploadedAt: "desc" },
      select: { selfieUploadedAt: true },
    }),
  ])

  return {
    total,
    oldest: oldest?.selfieUploadedAt?.toISOString() ?? null,
    newest: newest?.selfieUploadedAt?.toISOString() ?? null,
  }
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")

const deleteRangeSchema = z.object({
  from: dateSchema,
  to: dateSchema,
})

export type DeleteSelfiesResult = {
  ok?: boolean
  error?: string
  scanned?: number
  deleted?: number
  failed?: number
}

/// Bulk-delete every clock-in selfie whose `selfieUploadedAt` falls in
/// the inclusive [from, to] window for the active org. Hits Xero's
/// `DELETE /Files/{id}` per row, then nulls the AttendanceRecord
/// columns. Per-row failures are tallied but don't abort the batch.
export async function deleteSelfiesInRangeAction(
  _prev: DeleteSelfiesResult,
  formData: FormData,
): Promise<DeleteSelfiesResult> {
  const session = await requirePortalSession("ADMIN")
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { error: "Admin account is not assigned to an organisation." }
  }

  const parsed = deleteRangeSchema.safeParse({
    from: formData.get("from"),
    to: formData.get("to"),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid date range" }
  }
  if (parsed.data.from > parsed.data.to) {
    return { error: "Start date must be on or before end date." }
  }

  const prisma = getPrismaClient()
  if (!prisma) return { error: "Database is not configured." }

  const fromDate = new Date(`${parsed.data.from}T00:00:00.000Z`)
  const toDate = new Date(`${parsed.data.to}T23:59:59.999Z`)

  const stale = await prisma.attendanceRecord.findMany({
    where: {
      xeroSelfieFileId: { not: null },
      selfieUploadedAt: { gte: fromDate, lte: toDate },
      employee: { organizationId },
    },
    select: {
      id: true,
      xeroSelfieFileId: true,
      employee: {
        select: {
          organizationId: true,
          employeeProfile: { select: { xeroConnectionId: true } },
        },
      },
    },
    take: 500,
  })

  let deleted = 0
  let failed = 0

  for (const record of stale) {
    const fileId = record.xeroSelfieFileId
    if (!fileId) continue
    try {
      let connectionId =
        record.employee.employeeProfile?.xeroConnectionId ?? null
      if (!connectionId && record.employee.organizationId) {
        const conn = await prisma.xeroConnection.findFirst({
          where: { organizationId: record.employee.organizationId },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
        connectionId = conn?.id ?? null
      }
      if (connectionId) {
        const token = await getUsableXeroAccessToken(connectionId)
        if (token) {
          await deleteXeroFile({
            accessToken: token.accessToken,
            tenantId: token.tenantId,
            fileId,
          })
        }
      }
      await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { xeroSelfieFileId: null, selfieUploadedAt: null },
      })
      deleted++
    } catch (err) {
      console.error(
        `[deleteSelfiesInRangeAction] failed for record ${record.id}`,
        err,
      )
      failed++
    }
  }

  revalidatePath("/admin/attendance")

  return { ok: true, scanned: stale.length, deleted, failed }
}
