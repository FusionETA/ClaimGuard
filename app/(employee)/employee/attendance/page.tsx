import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

import { EmployeeAttendanceDashboardView } from "./dashboard-view"

export default async function EmployeeAttendancePage() {
  const session = await requirePortalSession("EMPLOYEE")
  const dashboard = await employeeAttendanceService.getEmployeeDashboard(session.userId)

  return (
    <div className="attendance-module -mx-6 -my-6 px-6 py-6 lg:-my-8 lg:py-8">
      <EmployeeAttendanceDashboardView
        firstName={session.name.split(" ")[0] ?? session.name}
        dashboard={dashboard}
      />
    </div>
  )
}
