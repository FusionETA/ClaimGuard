import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"

import { EmployeeAttendanceDashboardView } from "./dashboard-view"
import { loadMyHoursSummaryAction } from "./hours-summary-actions"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export default async function EmployeeAttendancePage() {
  const session = await requirePortalSession("EMPLOYEE")
  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const [dashboard, workingHours, projects, hoursSummary] = await Promise.all([
    employeeAttendanceService.getEmployeeDashboard(session.userId),
    employeeAttendanceService.getWorkingHours(session.userId),
    employeeAttendanceService.getAvailableProjects(session.userId),
    employeeAttendanceService.getHoursSummary(
      session.userId,
      new Date(initialFrom),
      new Date(initialTo),
    ),
  ])

  return (
    <div className="space-y-4">
      <EmployeeAttendanceDashboardView
        firstName={session.name.split(" ")[0] ?? session.name}
        dashboard={dashboard}
        workingHours={workingHours}
        projects={projects}
      />
      <HoursSummaryPanel
        title="My hours summary"
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialData={hoursSummary}
        loadAction={loadMyHoursSummaryAction}
      />
    </div>
  )
}
