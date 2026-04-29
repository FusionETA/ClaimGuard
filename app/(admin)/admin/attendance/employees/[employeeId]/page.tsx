import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { EmployeeDetailView } from "@/components/attendance/employee-detail-view"
import { requirePortalSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

export default async function AdminEmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>
}) {
  const { employeeId } = await params
  const session = await requirePortalSession("ADMIN")
  const data = await adminAttendanceService.getEmployeeDetail(
    session.organizationId ?? null,
    employeeId,
  )
  if (!data) notFound()

  return (
    <div className="space-y-4">
      <Link
        href="/admin/attendance/employees"
        className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to employees
      </Link>
      <EmployeeDetailView data={data} />
    </div>
  )
}
