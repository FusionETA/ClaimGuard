import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export default async function SupervisorEmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>
}) {
  const { employeeId } = await params
  const session = await requirePortalSession("SUPERVISOR")
  const data = await supervisorAttendanceService.getEmployeeDetail(
    session.userId,
    employeeId,
  )
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
    </div>
  )
}
