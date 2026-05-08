import "server-only"

import { DEFAULT_GEOFENCE_RADIUS_METERS, checkGeofence } from "@/lib/geo"
import { getPrismaClient } from "@/lib/prisma"
import {
  getOrCreateAttendanceSelfieFolder,
  uploadFileToXero,
} from "@/lib/xero"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  AttendanceProjectView,
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

const ARCHIVED_XERO_STATUSES = new Set(["CLOSED", "ARCHIVED"])

const OFF_SITE_REMARK_REQUIRED =
  "You're outside the project geofence. Please add a remark before continuing."

/**
 * Resolve the geofence radius for an employee's organisation. Always returns a
 * number — falls back to the system default when no org is set or the org has
 * no override configured.
 */
async function resolveGeofenceRadius(orgId: string | null): Promise<number> {
  const value = await attendanceRepository.getGeofenceRadiusForOrganization(orgId)
  return value ?? DEFAULT_GEOFENCE_RADIUS_METERS
}

/**
 * Throws `OFF_SITE_REMARK_REQUIRED` if the employee is currently outside the
 * geofence of their active project AND has not provided a remark. Used by the
 * clock-out and break flows. No-ops when the active record has no project.
 */
async function enforceGeofenceForActiveRecord(
  employeeId: string,
  coords: { lat: number; lng: number } | undefined,
  notes: string | undefined,
): Promise<void> {
  const projectId = await attendanceRepository.getTodayProjectId(employeeId)
  if (!projectId) return

  const [project, orgId] = await Promise.all([
    attendanceRepository.getProjectGeoById(projectId),
    attendanceRepository.getOrganizationIdForUser(employeeId),
  ])
  if (!project) return

  const radius = await resolveGeofenceRadius(orgId)
  const fence = checkGeofence(coords ?? null, project, radius)
  if (!fence.withinRadius && !notes) {
    throw new Error(OFF_SITE_REMARK_REQUIRED)
  }
}

/// Decode a `data:image/jpeg;base64,…` URL and upload it to the org's
/// Xero "Attendance Selfie" folder, then attach the resulting file ID
/// to the AttendanceRecord. Skips silently when the employee isn't
/// hourly, has no Xero connection, or the data URL is malformed —
/// the caller wraps in try/catch so a thrown error never blocks the
/// clock-in itself.
async function uploadSelfieToXero({
  employeeId,
  attendanceRecordId,
  dataUrl,
}: {
  employeeId: string
  attendanceRecordId: string
  dataUrl: string
}): Promise<void> {
  const prisma = getPrismaClient()
  if (!prisma) return

  const profile = await prisma.employeeProfile.findUnique({
    where: { userId: employeeId },
    select: { payoutMethod: true, xeroConnectionId: true, employeeId: true },
  })
  if (!profile || profile.payoutMethod !== "HOURLY") return

  // Resolve a Xero connection: profile preference, else org's first.
  let connectionId: string | null = profile.xeroConnectionId ?? null
  if (!connectionId) {
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true },
    })
    if (user?.organizationId) {
      const conn = await prisma.xeroConnection.findFirst({
        where: { organizationId: user.organizationId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
      connectionId = conn?.id ?? null
    }
  }
  if (!connectionId) return

  // data URL → Buffer
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return
  const mimeType = match[1] ?? "image/jpeg"
  const fileBuffer = Buffer.from(match[2] ?? "", "base64")
  if (fileBuffer.length === 0) return

  const token = await getUsableXeroAccessToken(connectionId)
  if (!token) return

  const folderId = await getOrCreateAttendanceSelfieFolder({
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  })

  const ext = mimeType === "image/png" ? "png" : "jpg"
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${profile.employeeId}_${stamp}.${ext}`

  const upload = await uploadFileToXero({
    accessToken: token.accessToken,
    tenantId: token.tenantId,
    folderId,
    fileBuffer,
    fileName,
    mimeType,
  })

  await prisma.attendanceRecord.update({
    where: { id: attendanceRecordId },
    data: {
      xeroSelfieFileId: upload.fileId,
      selfieUploadedAt: new Date(),
    },
  })
}

export const employeeAttendanceService = {
  async getEmployeeDashboard(employeeId: string): Promise<EmployeeAttendanceDashboard> {
    const [today, weekToDate, todayEvents, recentOT, orgId, todayProjectId] =
      await Promise.all([
        attendanceRepository.getTodayAttendance(employeeId),
        attendanceRepository.getWeekAttendance(employeeId),
        attendanceRepository.getTodayEvents(employeeId),
        attendanceRepository.getEmployeeOTApprovals(employeeId),
        attendanceRepository.getOrganizationIdForUser(employeeId),
        attendanceRepository.getTodayProjectId(employeeId),
      ])

    const geofenceRadiusMeters = await resolveGeofenceRadius(orgId)

    let activeProjectCoords:
      | { latitude: number | null; longitude: number | null }
      | null = null
    if (todayProjectId) {
      const project = await attendanceRepository.getProjectGeoById(todayProjectId)
      if (project) {
        activeProjectCoords = {
          latitude: project.latitude,
          longitude: project.longitude,
        }
      }
    }

    return {
      today,
      weekToDate,
      todayEvents,
      recentOT,
      geofenceRadiusMeters,
      activeProjectCoords,
    }
  },

  async getEmployeeHistory(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<AttendanceRecordView[]> {
    return attendanceRepository.getAttendanceHistory(employeeId, from, to)
  },

  async getEmployeeOTRecords(employeeId: string): Promise<ApprovalRequestView[]> {
    return attendanceRepository.getEmployeeOTApprovals(employeeId)
  },

  async getWorkingHours(employeeId: string): Promise<{ start: string; end: string }> {
    const orgId = await attendanceRepository.getOrganizationIdForUser(employeeId)
    return attendanceRepository.getWorkingHours(orgId)
  },

  async getAvailableProjects(employeeId: string): Promise<AttendanceProjectView[]> {
    const data = await attendanceRepository.getEmployeeProjectAssignments(employeeId)
    if (!data || !data.organizationId) return []

    return data.assignments
      .filter((project) =>
        !project.status || !ARCHIVED_XERO_STATUSES.has(project.status.toUpperCase())
      )
      .map((project) => ({
        id: project.id,
        name: project.name,
        latitude: project.latitude,
        longitude: project.longitude,
      }))
  },

  async clockIn(
    employeeId: string,
    projectId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
    /// Hourly Worker selfie (data URL). Storage TBD — captured here so
    /// the call site can wire it in once the upload target is decided.
    /// For now we just acknowledge receipt; nothing is persisted.
    selfie?: string,
  ) {
    const [project, orgId] = await Promise.all([
      attendanceRepository.getProjectGeoById(projectId),
      attendanceRepository.getOrganizationIdForUser(employeeId),
    ])
    if (!project) throw new Error("Selected project does not exist")

    const radius = await resolveGeofenceRadius(orgId)
    const fence = checkGeofence(coords ?? null, project, radius)
    if (!fence.withinRadius && !notes) {
      throw new Error(OFF_SITE_REMARK_REQUIRED)
    }

    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    const result = await attendanceRepository.clockIn(
      employeeId,
      project.name,
      location,
      projectId,
      notes,
    )

    // Hourly Worker selfie → Xero Files. Inline (Vercel can't fire-
    // and-forget) so this adds ~1–2s to clock-in latency in the happy
    // path. Failures here are logged and swallowed: clocking in must
    // succeed even when Xero is misconfigured / rate-limited / down.
    if (selfie) {
      try {
        await uploadSelfieToXero({
          employeeId,
          attendanceRecordId: result.recordId,
          dataUrl: selfie,
        })
      } catch (err) {
        console.error("[clockIn] selfie upload failed", err)
      }
    }

    return result
  },

  async clockOut(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
  ) {
    await enforceGeofenceForActiveRecord(employeeId, coords, notes)
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.clockOut(employeeId, location, notes)
  },

  async startBreak(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
  ) {
    await enforceGeofenceForActiveRecord(employeeId, coords, notes)
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.startBreak(employeeId, location, notes)
  },

  async endBreak(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
  ) {
    await enforceGeofenceForActiveRecord(employeeId, coords, notes)
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.endBreak(employeeId, location, notes)
  },

  async getHoursSummary(employeeId: string, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ employeeId, from, to })
  },
}
