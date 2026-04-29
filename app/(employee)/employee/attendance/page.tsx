import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

import { EmployeeAttendanceDashboardView } from "./dashboard-view"

export default async function EmployeeAttendancePage() {
  const session = await requirePortalSession("EMPLOYEE")
  const dashboard = await employeeAttendanceService.getEmployeeDashboard(session.userId)

  return (
    <EmployeeAttendanceDashboardView
      firstName={session.name.split(" ")[0] ?? session.name}
      dashboard={dashboard}
    />
  )
}
