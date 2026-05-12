import Link from "next/link"
import { redirect } from "next/navigation"
import { AlertCircle, ChevronRight, CircleCheck, UserPlus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

      {incomplete.length > 0 && (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              {incomplete.length} employee
              {incomplete.length === 1 ? "" : "s"} need payroll setup
            </CardTitle>
            <CardDescription>
              These employees are missing statutory or compensation
              details. Click any row to complete their profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {incomplete.map((emp) => (
              <EmployeeRow key={emp.userId} employee={emp} state="incomplete" />
            ))}
          </CardContent>
        </Card>
      )}

      {complete.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleCheck className="h-4 w-4 text-emerald-600" />
              Ready for payroll
            </CardTitle>
            <CardDescription>
              These employees have complete payroll profiles and will be
              included in the next payroll run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {complete.map((emp) => (
              <EmployeeRow key={emp.userId} employee={emp} state="complete" />
            ))}
          </CardContent>
        </Card>
      )}

      {archived.length > 0 && (
        <Card className="opacity-70">
          <CardHeader>
            <CardTitle className="text-base">Archived</CardTitle>
            <CardDescription>
              Excluded from new payroll runs. Click to view historical
              payslips or un-archive.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {archived.map((emp) => (
              <EmployeeRow key={emp.userId} employee={emp} state="archived" />
            ))}
          </CardContent>
        </Card>
      )}

      {data.employees.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-4 w-4" />
              No employees yet
            </CardTitle>
            <CardDescription>
              Add employees in the Hierarchy section first. They&apos;ll
              appear here once they exist as users in this organisation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin/hierarchy">Open Hierarchy</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function EmployeeRow({
  employee,
  state,
}: {
  employee: {
    userId: string
    employeeId: string
    name: string
    email: string
    jobTitle: string
    hasProfile: boolean
  }
  state: "complete" | "incomplete" | "archived"
}) {
  return (
    <Link
      href={`/admin/payroll/employees/${employee.userId}`}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-primary/5"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {employee.name}
          <span className="ml-2 text-xs text-muted-foreground">
            {employee.employeeId}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {employee.jobTitle} · {employee.email}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {state === "complete" && (
          <Badge variant="outline" className="border-emerald-300/60 text-[10px] text-emerald-700">
            Ready
          </Badge>
        )}
        {state === "incomplete" && (
          <Badge variant="outline" className="border-amber-300/60 text-[10px] text-amber-700">
            {employee.hasProfile ? "Incomplete" : "Not set up"}
          </Badge>
        )}
        {state === "archived" && (
          <Badge variant="outline" className="text-[10px]">
            Archived
          </Badge>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </Link>
  )
}
