import { Card, CardContent } from "@/components/ui/card"
import { LeaveBalancesGrid } from "@/components/leave/leave-balances-grid"
import { ExportPdfDialog } from "@/components/admin/export-pdf-dialog"
import { listAllEmployeeBalancesForOrg } from "@/modules/leave/application/services/leave-entitlements.service"

export async function BalancesGridLoader({
  organizationId,
  year,
}: {
  organizationId: string
  year: number
}) {
  const employees = await listAllEmployeeBalancesForOrg(organizationId, year)

  if (employees.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No active employees</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add employees in{" "}
            <span className="font-semibold">Company/Employee → Manage Employee</span> to see
            balances here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <div className="flex justify-end">
        <ExportPdfDialog
          kind="leave"
          initialYear={year}
          employees={employees.map((e) => ({ id: e.userId, name: e.name }))}
        />
      </div>
      <LeaveBalancesGrid employees={employees} year={year} showSource />
    </>
  )
}
