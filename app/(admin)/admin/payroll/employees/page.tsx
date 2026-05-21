import { redirect } from "next/navigation"

/**
 * /admin/payroll/employees (legacy)
 *
 * The payroll employee list was merged into the unified "Manage
 * Employee" page under Company/Employee. This route now redirects
 * there so old bookmarks/links keep working. The per-employee detail
 * editor still lives at /admin/payroll/employees/[id].
 */
export default function LegacyPayrollEmployeesPage() {
  redirect("/admin/hierarchy")
}
