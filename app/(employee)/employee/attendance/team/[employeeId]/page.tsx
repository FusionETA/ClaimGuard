import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { HoursProgress } from "@/components/attendance/hours-progress"
import { ShiftAssignmentPanel } from "@/components/attendance/shift-assignment-panel"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { ReportExportButtons } from "@/components/attendance/report-export-buttons"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

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

  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const year = new Date().getUTCFullYear()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/employee/attendance/team"
          className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to team
        </Link>
        <ReportExportButtons
          employeeId={employeeId}
          from={initialFrom}
          to={initialTo}
          year={year}
        />
      </div>
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
