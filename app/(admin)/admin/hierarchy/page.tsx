import { redirect } from "next/navigation"

import { ManageEmployeeList } from "@/components/admin/manage-employee-list"
import { getManageEmployeesPageData } from "@/modules/payroll/application/services/payroll-profile.service"

/**
 * /admin/hierarchy — "Company/Employee → Manage Employee".
 *
 * Unified employee surface: a payroll-style list (summary row → click
 * → tabbed detail editor) plus an inline "Add employee" dialog. The
 * detail editor (under /admin/payroll/employees/[id]) carries the
 * Personal / Employment / Statutory / Company tabs, so everything about
 * one employee — org hierarchy + payroll — lives in one place.
 */
export default async function AdminManageEmployeePage() {
  const data = await getManageEmployeesPageData()
  if (!data) redirect("/login")

  const ready = data.employees.filter((e) => e.isComplete && !e.isArchived)
  const incomplete = data.employees.filter((e) => !e.isComplete && !e.isArchived)
  const archived = data.employees.filter((e) => e.isArchived)

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Manage Employee
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.organizationName ? `${data.organizationName} — ` : ""}
          {data.employees.length} employee
          {data.employees.length === 1 ? "" : "s"} ·{" "}
          {ready.length} ready for payroll
          {incomplete.length > 0 ? `, ${incomplete.length} need setup` : ""}
          {archived.length > 0 ? `, ${archived.length} archived` : ""}
        </p>
      </header>

      <ManageEmployeeList employees={data.employees} policies={data.policies} />
    </div>
  )
}
