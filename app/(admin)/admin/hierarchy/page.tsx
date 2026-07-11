import { redirect } from "next/navigation"

import { ManageEmployeeList } from "@/components/admin/manage-employee-list"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { hasAdminModule } from "@/modules/organization/application/services/admin-access.service"
import { getManageEmployeesPageData } from "@/modules/payroll/application/services/payroll-profile.service"
import { listPendingTransfersForOrg } from "@/modules/payroll/application/services/payroll-transfer.service"

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

  // The tab is always visible (even when `hierarchy` is not granted), so
  // admins can still browse the directory. Mutations — Add Employee +
  // Import — are hidden when the admin lacks the module.
  const canEdit = await hasAdminModule("hierarchy")

  // Fetch pending transfers for the active org so the list can render a
  // "Transfer pending → target company" badge on affected rows. Doesn't
  // fail the page if the query throws — an empty list just means no
  // badges get drawn.
  const session = await getCurrentSession()
  const activeOrgId = session ? resolveActiveOrgId(session) : undefined
  const pendingTransfers = activeOrgId
    ? await listPendingTransfersForOrg({ organizationId: activeOrgId })
    : []

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

      <ManageEmployeeList
        employees={data.employees}
        policies={data.policies}
        leaveTypes={data.leaveTypes}
        policyDefaults={data.policyDefaults}
        canEdit={canEdit}
        pendingTransfers={pendingTransfers.map((t) => ({
          userId: t.sourceUserId,
          targetOrganizationName: t.targetOrganizationName,
          effectiveDate: t.effectiveDate,
        }))}
      />
    </div>
  )
}
