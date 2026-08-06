import { notFound } from "next/navigation"

import { BackButton } from "@/components/ui/back-button"
import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { HoursProgress } from "@/components/attendance/hours-progress"
import { ShiftAssignmentPanel } from "@/components/attendance/shift-assignment-panel"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"

export default async function SupervisorEmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>
}) {
  const { employeeId } = await params
  const session = await requirePortalSession("SUPERVISOR")
  const orgId = resolveActiveOrgId(session) ?? null
  const [data, progress, timezone, shiftAssignments] = await Promise.all([
    supervisorAttendanceService.getEmployeeDetail(session.userId, employeeId),
    employeeAttendanceService.getProgress(employeeId),
    attendanceRepository.getOrgTimezone(orgId),
    // Phase 5: memberships this supervisor manages for the target
    // employee, with their available shift pool. Empty → panel
    // hides itself.
    supervisorAttendanceService.listShiftAssignmentsForEmployee(
      session.userId,
      employeeId,
    ),
  ])
  if (!data) notFound()

  return (
    <div className="space-y-4">
      <BackButton href="/employee/attendance/team" />
      <EmployeeDetailView data={data} viewerRole="SUPERVISOR" timezone={timezone} />
      <ShiftAssignmentPanel
        employeeId={employeeId}
        memberships={shiftAssignments}
      />
      <HoursProgress
        weekly={{
          actualMin: progress.week.actualMin,
          expectedMin: progress.week.expectedMin,
        }}
        monthly={{
          actualMin: progress.month.actualMin,
          expectedMin: progress.month.expectedMin,
        }}
      />
    </div>
  )
}
