import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { HoursProgress } from "@/components/attendance/hours-progress"
import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

import { loadEmployeeHoursSummaryAction } from "../../hours-summary-actions"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export default async function AdminEmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>
}) {
  const { employeeId } = await params
  const session = await requirePortalSession("ADMIN")
  await requireAdminModule("attendance")
  const orgId = resolveActiveOrgId(session) ?? null
  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const [data, hoursSummary, progress, timezone] = await Promise.all([
    adminAttendanceService.getEmployeeDetail(
      // Honour the dropdown-selected company; falls back to the home org.
      orgId,
      employeeId,
    ),
    adminAttendanceService.getEmployeeHoursSummary(
      employeeId,
      new Date(initialFrom),
      new Date(initialTo),
    ),
    adminAttendanceService.getEmployeeProgress(employeeId),
    attendanceRepository.getOrgTimezone(orgId),
  ])
  if (!data) notFound()

  const boundLoadAction = loadEmployeeHoursSummaryAction.bind(null, employeeId)

  const year = new Date().getUTCFullYear()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/admin/attendance/employees"
          className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to employees
        </Link>
        <div className="flex items-center gap-2">
          <a
            href={`/api/admin/export/attendance-report?employeeId=${employeeId}&from=${initialFrom}&to=${initialTo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Export Attendance PDF
          </a>
          <a
            href={`/api/admin/export/leave-summary?employeeId=${employeeId}&year=${year}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Export Leave PDF
          </a>
        </div>
      </div>
      <EmployeeDetailView data={data} viewerRole="ADMIN" timezone={timezone} />
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
      <HoursSummaryPanel
        title="Hours summary"
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialData={hoursSummary}
        loadAction={boundLoadAction}
      />
    </div>
  )
}
