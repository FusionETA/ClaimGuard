import "server-only"

import { DEFAULT_GEOFENCE_RADIUS_METERS, checkGeofence } from "@/lib/geo"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  AttendanceProjectView,
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

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

    if (data.assignments.length > 0) {
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
    }

    const legacyProject = data.legacyProject?.trim()
    if (legacyProject) {
      const projects = await organizationRepository.getProjectsForOrganization(
        data.organizationId
      )
      return projects
        .filter((project) => project.name === legacyProject)
        .filter((project) =>
          !project.status || !ARCHIVED_XERO_STATUSES.has(project.status.toUpperCase())
        )
        .map((project) => ({
          id: project.id,
          name: project.name,
          latitude: project.latitude ?? null,
          longitude: project.longitude ?? null,
        }))
    }

    return []
  },

  async clockIn(
    employeeId: string,
    projectId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
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
    return attendanceRepository.clockIn(
      employeeId,
      project.name,
      location,
      projectId,
      notes,
    )
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

  async confirmBreak(
    employeeId: string,
    coords?: { lat: number; lng: number },
    notes?: string,
  ) {
    await enforceGeofenceForActiveRecord(employeeId, coords, notes)
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.confirmBreak(employeeId, location, notes)
  },

  async getHoursSummary(employeeId: string, from: Date, to: Date) {
    return attendanceRepository.getHoursSummary({ employeeId, from, to })
  },
}
