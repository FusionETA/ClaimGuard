import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { DEFAULT_GEOFENCE_RADIUS_METERS, checkGeofence } from "@/lib/geo"
import { publishUserEvents } from "@/lib/realtime"
import { key } from "@/lib/redis"
import {
  getOrCreateAttendanceSelfieFolder,
  uploadFileToXero,
} from "@/lib/xero"
import {
  attendanceRepository,
  getAttendancePrismaClient,
  getAttendancePrismaClientSafe,
} from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  AttendanceProjectView,
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"
import { notify } from "@/modules/notifications/application/services/notification.service"

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

/// Resolve whether the employee's assigned policy enforces the geofence
/// check at clock-in. Defaults to `true` (the legacy behavior) when no
/// policy is assigned. Used to short-circuit server-side validation for
/// employees on a "no geofence" policy.
async function policyEnforcesGeofence(employeeId: string): Promise<boolean> {
  const prisma = getAttendancePrismaClientSafe()
  if (!prisma) return true
  const row = await prisma.employeeProfile.findUnique({
    where: { userId: employeeId },
    select: { policy: { select: { requireGeofence: true } } },
  })
  if (!row?.policy) return true
  return row.policy.requireGeofence
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
): Promise<{ distanceMeters: number | null }> {
  const projectId = await attendanceRepository.getTodayProjectId(employeeId)
  if (!projectId) return { distanceMeters: null }

  const [project, orgId, enforce] = await Promise.all([
    attendanceRepository.getProjectGeoById(projectId),
    attendanceRepository.getOrganizationIdForUser(employeeId),
    policyEnforcesGeofence(employeeId),
  ])
  if (!project) return { distanceMeters: null }

  const radius = await resolveGeofenceRadius(orgId)
  const fence = checkGeofence(coords ?? null, project, radius)
  if (enforce && !fence.withinRadius && !notes) {
    throw new Error(OFF_SITE_REMARK_REQUIRED)
  }
  return { distanceMeters: fence.distanceMeters }
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
  sessionId,
  dataUrl,
  phase = "clock-in",
}: {
  employeeId: string
  attendanceRecordId: string
  sessionId?: string
  dataUrl: string
  phase?: "clock-in" | "clock-out"
}): Promise<void> {
  const prisma = getAttendancePrismaClientSafe()
  if (!prisma) return

  const profile = await prisma.employeeProfile.findUnique({
    where: { userId: employeeId },
    select: {
      employeeId: true,
      policy: { select: { requireSelfie: true } },
    },
  })
  if (!profile) return
  // Clock-out selfies: the calling code only passes the selfie when the
  // client's policy required it, so no server-side re-check needed.
  if (phase !== "clock-out") {
    const selfieRequired = profile.policy?.requireSelfie ?? false
    if (!selfieRequired) return
  }

  // Resolve the org's single Xero connection.
  let connectionId: string | null = null
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

  const now = new Date()
  if (phase === "clock-out") {
    await prisma.attendanceRecord.update({
      where: { id: attendanceRecordId },
      data: { clockOutXeroSelfieFileId: upload.fileId },
    })
  } else {
    await Promise.all([
      // Keep the record-level field for backward-compat consumers.
      prisma.attendanceRecord.update({
        where: { id: attendanceRecordId },
        data: {
          xeroSelfieFileId: upload.fileId,
          selfieUploadedAt: now,
        },
      }),
      // Write to the session so each clock-in has its own selfie.
      ...(sessionId
        ? [
            prisma.attendanceSession.update({
              where: { id: sessionId },
              data: {
                xeroSelfieFileId: upload.fileId,
                selfieUploadedAt: now,
              },
            }),
          ]
        : []),
    ])
  }
}

/// Resolves the [Mon..Sun] week and [first..last day of month] month UTC
/// ranges anchored on "today" in the employee's org timezone. Returned
/// dates are UTC midnight at the start day and UTC end-of-day at the
/// last day; the repository further normalizes via startOfDay/endOfDay.
async function resolveProgressRanges(employeeId: string): Promise<{
  weekRange: { from: Date; to: Date }
  monthRange: { from: Date; to: Date }
}> {
  const prisma = getAttendancePrismaClientSafe()
  let timezone = "Asia/Kuala_Lumpur"
  if (prisma) {
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organization: { select: { timezone: true } } },
    })
    if (user?.organization?.timezone) timezone = user.organization.timezone
  }

  // Get YYYY-MM-DD in the org's local timezone
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = fmt.formatToParts(new Date())
  const y = Number(parts.find((p) => p.type === "year")?.value ?? "0")
  const m = Number(parts.find((p) => p.type === "month")?.value ?? "0")
  const d = Number(parts.find((p) => p.type === "day")?.value ?? "0")
  const today = new Date(Date.UTC(y, m - 1, d))

  // ISO week: Monday = 1, Sunday = 7. Find the Monday of today's week.
  const isoDay = ((today.getUTCDay() + 6) % 7) + 1 // 1..7
  const weekFrom = new Date(today)
  weekFrom.setUTCDate(today.getUTCDate() - (isoDay - 1))
  const weekTo = new Date(weekFrom)
  weekTo.setUTCDate(weekFrom.getUTCDate() + 6)

  const monthFrom = new Date(Date.UTC(y, m - 1, 1))
  const monthTo = new Date(Date.UTC(y, m, 0)) // last day of month

  return {
    weekRange: { from: weekFrom, to: weekTo },
    monthRange: { from: monthFrom, to: monthTo },
  }
}

export const employeeAttendanceService = {
  /**
   * Profile extras for the attendance dashboard: OT payout method, the
   * current time-bank balance, and whether the policy requires a selfie
   * on clock-in. Returns `null` when the user has no employee profile
   * (e.g. an admin testing the employee surface).
   *
   * Pages should call this instead of opening a Prisma client to look
   * up the employee profile themselves.
   */
  async getProfileExtras(userId: string): Promise<{
    otPayoutMethod: "CASH" | "TIME_BANK"
    otTimeBalanceMin: number
    requiresSelfieOnClockIn: boolean
  } | null> {
    const extras = await attendanceRepository.getEmployeeOtExtras(userId)
    if (!extras) return null
    const otPayoutMethod =
      extras.otEnabled && extras.otMethod === "TIME_BANK" ? "TIME_BANK" : "CASH"
    return {
      otPayoutMethod,
      otTimeBalanceMin: extras.otTimeBalanceMin,
      requiresSelfieOnClockIn: extras.requireSelfie,
    }
  },

  async getEmployeeDashboard(employeeId: string): Promise<EmployeeAttendanceDashboard> {
    // Today-scoped — include the day in the key so a midnight rollover
    // doesn't surface yesterday's "today" within the 60s TTL window.
    const today = new Date().toISOString().slice(0, 10)
    return getOrSetCache(
      key("user", employeeId, "attendance", "dashboard", today),
      60,
      async () => {
        const [
          today,
          weekToDate,
          todayEvents,
          recentOT,
          orgId,
          todayProjectId,
          pendingApproval,
        ] = await Promise.all([
          attendanceRepository.getTodayAttendance(employeeId),
          attendanceRepository.getWeekAttendance(employeeId),
          attendanceRepository.getTodayEvents(employeeId),
          attendanceRepository.getEmployeeOTApprovals(employeeId),
          attendanceRepository.getOrganizationIdForUser(employeeId),
          attendanceRepository.getTodayProjectId(employeeId),
          attendanceRepository.findPendingClockOrBreakApprovalForDay(
            employeeId,
            new Date(),
          ),
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
          pendingApproval,
        }
      },
    )
  },

  async getEmployeeHistory(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<AttendanceRecordView[]> {
    return getOrSetCache(
      key(
        "user",
        employeeId,
        "attendance",
        "history",
        from.toISOString(),
        to.toISOString(),
      ),
      60,
      () => attendanceRepository.getAttendanceHistory(employeeId, from, to),
    )
  },

  /**
   * Rejected CLOCK_IN / CLOCK_OUT approvals in a date range, keyed by
   * `date.toISOString().slice(0,10)`. Used by the history view to annotate
   * days where a clock event was rejected (the underlying record has
   * already been cleared by `reviewApproval`, but the employee still
   * benefits from seeing *why* the day looks empty).
   */
  async getRejectedClockEvents(
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{
    date: string
    kind: "CLOCK_IN" | "CLOCK_OUT"
    eventAt: string
    reviewNotes: string | null
    reviewerName: string | null
  }>> {
    return attendanceRepository.getRejectedClockEvents(employeeId, from, to)
  },

  async getEmployeeOTRecords(employeeId: string): Promise<ApprovalRequestView[]> {
    return getOrSetCache(
      key("user", employeeId, "attendance", "ot-records"),
      60,
      () => attendanceRepository.getEmployeeOTApprovals(employeeId),
    )
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
        workingDays: project.workingDays ?? null,
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
    const enforceFence = await policyEnforcesGeofence(employeeId)
    if (enforceFence && !fence.withinRadius && !notes) {
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
      coords
        ? {
            lat: coords.lat,
            lng: coords.lng,
            distanceMeters: fence.distanceMeters,
          }
        : undefined,
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
          sessionId: result.sessionId,
          dataUrl: selfie,
        })
      } catch (err) {
        console.error("[clockIn] selfie upload failed", err)
      }
    }

    // Live: nudge the supervisors who can approve this pending clock-in
    // so it appears in their queue immediately (silent — no bell spam;
    // the digest cron still owns batched reminders).
    if (result.pendingApproverIds.length > 0) {
      await publishUserEvents(result.pendingApproverIds, {
        type: "refresh",
        scope: "attendance",
      })
    }

    return result
  },

  async clockOut(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
    selfie?: string,
  ) {
    const { distanceMeters } = await enforceGeofenceForActiveRecord(
      employeeId,
      coords,
      notes,
    )
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    const result = await attendanceRepository.clockOut(
      employeeId,
      location,
      notes,
      coords ? { lat: coords.lat, lng: coords.lng, distanceMeters } : undefined,
    )

    if (selfie) {
      try {
        await uploadSelfieToXero({
          employeeId,
          attendanceRecordId: result.recordId,
          dataUrl: selfie,
          phase: "clock-out",
        })
      } catch (err) {
        console.error("[clockOut] selfie upload failed", err)
      }
    }

    // Live nudge for any pending clock-out / auto-OT approvals.
    if (result.pendingApproverIds.length > 0) {
      await publishUserEvents(result.pendingApproverIds, {
        type: "refresh",
        scope: "attendance",
      })
    }

    return result
  },

  async startBreak(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
  ) {
    const { distanceMeters } = await enforceGeofenceForActiveRecord(
      employeeId,
      coords,
      notes,
    )
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.startBreak(
      employeeId,
      location,
      notes,
      coords ? { lat: coords.lat, lng: coords.lng, distanceMeters } : undefined,
    )
  },

  async endBreak(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
  ) {
    const { distanceMeters } = await enforceGeofenceForActiveRecord(
      employeeId,
      coords,
      notes,
    )
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.endBreak(
      employeeId,
      location,
      notes,
      coords ? { lat: coords.lat, lng: coords.lng, distanceMeters } : undefined,
    )
  },

  async getHoursSummary(employeeId: string, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ employeeId, from, to })
  },

  /// Returns weekly + monthly actual-vs-expected working minutes for the
  /// employee, anchored on the org's local "today". Used by the
  /// attendance dashboard's "Hours progress" card and detail pages.
  async getProgress(employeeId: string): Promise<{
    week: { from: Date; to: Date; actualMin: number; expectedMin: number }
    month: { from: Date; to: Date; actualMin: number; expectedMin: number }
  }> {
    const { weekRange, monthRange } = await resolveProgressRanges(employeeId)
    const [week, month] = await Promise.all([
      attendanceRepository.getEmployeeRangeProgress({
        employeeId,
        from: weekRange.from,
        to: weekRange.to,
      }),
      attendanceRepository.getEmployeeRangeProgress({
        employeeId,
        from: monthRange.from,
        to: monthRange.to,
      }),
    ])
    return {
      week: { ...weekRange, ...week },
      month: { ...monthRange, ...month },
    }
  },

  async updateTodayRemark(
    employeeId: string,
    attendanceRecordId: string,
    remark: string | null,
  ): Promise<void> {
    await attendanceRepository.updateAttendanceRemark({
      attendanceRecordId,
      employeeId,
      remark,
    })
  },

  async sendOtWarningNotifications({ orgId }: { orgId: string }): Promise<number> {
    const openRecords = await attendanceRepository.findOpenRecordsForOtWarning({ orgId })
    let notified = 0
    for (const record of openRecords) {
      try {
        await notify({
          userId: record.employeeId,
          organizationId: orgId,
          type: "ATTENDANCE_APPROVAL",
          title: "You're on overtime",
          body: "You've been clocked in past your OT threshold. Please add a shift remark and remember to clock out.",
          url: "/employee/attendance",
        })
        notified += 1
      } catch {
        // Non-fatal — continue notifying other employees.
      }
    }
    return notified
  },
}
