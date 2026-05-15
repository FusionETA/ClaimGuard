import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { HoursProgress } from "@/components/attendance/hours-progress"
import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export default async function SupervisorEmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>
}) {
  const { employeeId } = await params
  const session = await requirePortalSession("SUPERVISOR")
  const [data, progress] = await Promise.all([
    supervisorAttendanceService.getEmployeeDetail(session.userId, employeeId),
    employeeAttendanceService.getProgress(employeeId),
  ])
  if (!data) notFound()

  return (
    <div className="space-y-4">
      <Link
        href="/employee/attendance/team"
        className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to team
      </Link>
      <EmployeeDetailView data={data} viewerRole="SUPERVISOR" />
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
