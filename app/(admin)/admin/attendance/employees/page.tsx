import { AdminEmployeesList } from "@/components/admin/admin-employees-list"
import { requirePortalSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

export default async function AdminEmployeesPage() {
  const session = await requirePortalSession("ADMIN")
  const orgId = session.organizationId ?? null
  const employees = await adminAttendanceService.getEmployeeList(orgId)

  return <AdminEmployeesList employees={employees} />
}
