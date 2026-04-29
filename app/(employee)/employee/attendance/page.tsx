import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

import { EmployeeAttendanceDashboardView } from "./dashboard-view"

export default async function EmployeeAttendancePage() {
  const session = await requirePortalSession("EMPLOYEE")
  const [dashboard, workingHours, projects] = await Promise.all([
    employeeAttendanceService.getEmployeeDashboard(session.userId),
    employeeAttendanceService.getWorkingHours(session.userId),
    employeeAttendanceService.getAvailableProjects(session.userId),
  ])

  return (
    <EmployeeAttendanceDashboardView
      firstName={session.name.split(" ")[0] ?? session.name}
      dashboard={dashboard}
      workingHours={workingHours}
      projects={projects}
    />
  )
}
