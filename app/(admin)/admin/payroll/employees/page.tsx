import { redirect } from "next/navigation"

import { PayrollEmployeeListTables } from "@/components/admin/payroll-employee-list-tables"
import { getPayrollEmployeesPageData } from "@/modules/payroll/application/services/payroll-profile.service"

/**
 * Admin payroll → Employees list.
 *
 * Lists every employee in the org with their payroll-profile state.
 * Shows three buckets visually:
 *   - ✓ Complete   — payroll profile filled in, ready for runs
 *   - ⚠ Incomplete — missing required fields (or no profile yet)
 *   - 📁 Archived   — opted out / left company
 *
 * Clicking any row opens the per-employee detail page with three tabs:
 * Personal / Employment / Statutory.
 */
export default async function AdminPayrollEmployeesPage() {
  const data = await getPayrollEmployeesPageData()
  if (!data) redirect("/admin")

  const complete = data.employees.filter((e) => e.isComplete && !e.isArchived)
  const incomplete = data.employees.filter((e) => !e.isComplete && !e.isArchived)
  const archived = data.employees.filter((e) => e.isArchived)

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Payroll Employees
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.organizationName ? `${data.organizationName} — ` : ""}
          {data.employees.length} employee
          {data.employees.length === 1 ? "" : "s"} ·{" "}
          {complete.length} ready for payroll
          {incomplete.length > 0 ? `, ${incomplete.length} need setup` : ""}
          {archived.length > 0 ? `, ${archived.length} archived` : ""}
        </p>
      </header>

      <PayrollEmployeeListTables employees={data.employees} />
    </div>
  )
}
