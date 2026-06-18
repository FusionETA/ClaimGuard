import { AdminEmployeesList } from "@/components/admin/admin-employees-list"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

export default async function AdminEmployeesPage() {
  const session = await requirePortalSession("ADMIN")
  await requireAdminModule("attendance")
  // resolveActiveOrgId honours the company dropdown — without it, the
  // employee list always shows the admin's home org regardless of which
  // company they've selected from the header.
  const orgId = resolveActiveOrgId(session) ?? null
  const employees = await adminAttendanceService.getEmployeeList(orgId)

  return <AdminEmployeesList employees={employees} />
}
