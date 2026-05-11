import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

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
  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const [data, hoursSummary] = await Promise.all([
    adminAttendanceService.getEmployeeDetail(
      // Honour the dropdown-selected company; falls back to the home org.
      resolveActiveOrgId(session) ?? null,
      employeeId,
    ),
    adminAttendanceService.getEmployeeHoursSummary(
      employeeId,
      new Date(initialFrom),
      new Date(initialTo),
    ),
  ])
  if (!data) notFound()

  const boundLoadAction = loadEmployeeHoursSummaryAction.bind(null, employeeId)

  return (
    <div className="space-y-4">
      <Link
        href="/admin/attendance/employees"
        className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to employees
      </Link>
      <EmployeeDetailView data={data} viewerRole="ADMIN" />
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
