import "server-only"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  ApprovalRequestView,
  AttendanceProjectView,
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
} from "@/modules/attendance/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { getPrismaClient } from "@/lib/prisma"
import { DEFAULT_GEOFENCE_RADIUS_METERS, checkGeofence } from "@/lib/geo"

const ARCHIVED_XERO_STATUSES = new Set(["CLOSED", "ARCHIVED"])

const OFF_SITE_REMARK_REQUIRED = "You're outside the project geofence. Please add a remark before continuing."

export const employeeAttendanceService = {
  async getEmployeeDashboard(employeeId: string): Promise<EmployeeAttendanceDashboard> {
    const [today, weekToDate, todayEvents, recentOT] = await Promise.all([
      attendanceRepository.getTodayAttendance(employeeId),
      attendanceRepository.getWeekAttendance(employeeId),
      attendanceRepository.getTodayEvents(employeeId),
      attendanceRepository.getEmployeeOTApprovals(employeeId),
    ])

    const prisma = getPrismaClient()
    let geofenceRadiusMeters = DEFAULT_GEOFENCE_RADIUS_METERS
    let activeProjectCoords:
      | { latitude: number | null; longitude: number | null }
      | null = null

    if (prisma) {
      const user = await prisma.user.findUnique({
        where: { id: employeeId },
        select: { organizationId: true },
      })
      if (user?.organizationId) {
        const org = await prisma.organization.findUnique({
          where: { id: user.organizationId },
          select: { geofenceRadiusMeters: true },
        })
        if (org?.geofenceRadiusMeters) geofenceRadiusMeters = org.geofenceRadiusMeters
      }

      const todayRecord = await prisma.attendanceRecord.findUnique({
        where: {
          employeeId_date: {
            employeeId,
            date: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"),
          },
        },
        select: { projectId: true },
      })
      if (todayRecord?.projectId) {
        const proj = await prisma.xeroProject.findUnique({
          where: { id: todayRecord.projectId },
          select: { latitude: true, longitude: true },
        })
        if (proj) {
          activeProjectCoords = { latitude: proj.latitude, longitude: proj.longitude }
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
    const prisma = getPrismaClient()
    if (!prisma) return { start: "09:00", end: "18:00" }
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true },
    })
    return attendanceRepository.getWorkingHours(user?.organizationId ?? null)
  },

  async getAvailableProjects(employeeId: string): Promise<AttendanceProjectView[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const user = await prisma.user.findUnique({
      where: { id: employeeId },
      select: {
        organizationId: true,
        employeeProfile: {
          select: {
            project: true,
            projectAssignments: {
              select: {
                project: {
                  select: {
                    id: true,
                    name: true,
                    status: true,
                    latitude: true,
                    longitude: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    })
    if (!user?.organizationId) return []

    const assignedProjects = user.employeeProfile?.projectAssignments ?? []
    if (assignedProjects.length > 0) {
      return assignedProjects
        .map((assignment) => assignment.project)
        .filter((project) => !project.status || !ARCHIVED_XERO_STATUSES.has(project.status.toUpperCase()))
        .map((project) => ({
          id: project.id,
          name: project.name,
          latitude: project.latitude,
          longitude: project.longitude,
        }))
    }

    const legacyProject = user.employeeProfile?.project?.trim()
    if (legacyProject) {
      const projects = await organizationRepository.getProjectsForOrganization(user.organizationId)
      return projects
        .filter((project) => project.name === legacyProject)
        .filter((project) => !project.status || !ARCHIVED_XERO_STATUSES.has(project.status.toUpperCase()))
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
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured")
    const [project, user] = await Promise.all([
      prisma.xeroProject.findUnique({
        where: { id: projectId },
        select: { name: true, latitude: true, longitude: true },
      }),
      prisma.user.findUnique({
        where: { id: employeeId },
        select: { organizationId: true },
      }),
    ])
    if (!project) throw new Error("Selected project does not exist")

    const radius = await getRadiusFor(prisma, user?.organizationId ?? null)
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
}

async function getRadiusFor(
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>,
  organizationId: string | null,
): Promise<number> {
  if (!organizationId) return DEFAULT_GEOFENCE_RADIUS_METERS
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { geofenceRadiusMeters: true },
  })
  return org?.geofenceRadiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS
}

async function enforceGeofenceForActiveRecord(
  employeeId: string,
  coords: { lat: number; lng: number } | undefined,
  notes: string | undefined,
): Promise<void> {
  const prisma = getPrismaClient()
  if (!prisma) return
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z")
  const record = await prisma.attendanceRecord.findUnique({
    where: { employeeId_date: { employeeId, date: today } },
    select: { projectId: true },
  })
  if (!record?.projectId) return // legacy record, no geofence info
  const [project, user] = await Promise.all([
    prisma.xeroProject.findUnique({
      where: { id: record.projectId },
      select: { latitude: true, longitude: true },
    }),
    prisma.user.findUnique({
      where: { id: employeeId },
      select: { organizationId: true },
    }),
  ])
  if (!project) return
  const radius = await getRadiusFor(prisma, user?.organizationId ?? null)
  const fence = checkGeofence(coords ?? null, project, radius)
  if (!fence.withinRadius && !notes) {
    throw new Error(OFF_SITE_REMARK_REQUIRED)
  }
}
