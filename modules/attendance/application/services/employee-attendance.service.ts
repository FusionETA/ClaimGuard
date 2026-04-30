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

const ARCHIVED_XERO_STATUSES = new Set(["CLOSED", "ARCHIVED"])

export const employeeAttendanceService = {
  async getEmployeeDashboard(employeeId: string): Promise<EmployeeAttendanceDashboard> {
    const [today, weekToDate, todayEvents, recentOT] = await Promise.all([
      attendanceRepository.getTodayAttendance(employeeId),
      attendanceRepository.getWeekAttendance(employeeId),
      attendanceRepository.getTodayEvents(employeeId),
      attendanceRepository.getEmployeeOTApprovals(employeeId),
    ])
    return { today, weekToDate, todayEvents, recentOT }
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
        .map((project) => ({ id: project.id, name: project.name }))
    }

    const projects = await organizationRepository.getProjectsForOrganization(user.organizationId)
    const legacyProject = user.employeeProfile?.project?.trim()
    if (legacyProject) {
      return projects
        .filter((project) => project.name === legacyProject)
        .filter((project) => !project.status || !ARCHIVED_XERO_STATUSES.has(project.status.toUpperCase()))
        .map((project) => ({ id: project.id, name: project.name }))
    }

    return projects
      .filter((p) => !p.status || !ARCHIVED_XERO_STATUSES.has(p.status.toUpperCase()))
      .map((p) => ({ id: p.id, name: p.name }))
  },

  async clockIn(
    employeeId: string,
    projectId: string,
    coords?: { lat: number; lng: number },
  ) {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured")
    const project = await prisma.xeroProject.findUnique({
      where: { id: projectId },
      select: { name: true },
    })
    if (!project) throw new Error("Selected project does not exist")
    const location = coords
      ? `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`
      : undefined
    return attendanceRepository.clockIn(employeeId, project.name, location)
  },

  async clockOut(employeeId: string) {
    return attendanceRepository.clockOut(employeeId)
  },

  async confirmBreak(employeeId: string) {
    return attendanceRepository.confirmBreak(employeeId)
  },
}
