import Link from "next/link"
import { redirect } from "next/navigation"
import {
  Banknote,
  ClipboardList,
  Settings2,
  Users,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getCurrentSession } from "@/lib/auth/session"

/**
 * Payroll overview / landing page.
 *
 * v1 scope — minimal: shows the three sub-sections (Employees, Runs,
 * Settings) as navigation cards. The runs / settings pages are stubs
 * for now (built out in Phases 2 + 3); Employees is functional after
 * Phase 1.
 */
export default async function AdminPayrollPage() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
          <Banknote className="h-6 w-6 text-primary" />
          Payroll
        </h1>
        <p className="text-sm text-muted-foreground">
          Automated payroll for Malaysian operations. Set up employee
          statutory information, run monthly payroll, generate payslips.
        </p>
        <p className="text-xs text-muted-foreground">
          v1: basic pay, OT, allowances, EPF, SOCSO, EIS, HRDF (HRD
          Corp levy), PCB (income tax) for residents + non-residents.
        </p>
        <p className="text-[11px] text-amber-700 dark:text-amber-500">
          ⚠ PCB is a preview — uses LHDN 2024 tax bands as a proxy and
          implements only the normal-remuneration path. TP1 deductions
          and the bonus/commission path are not yet collected. Validate
          against LHDN&apos;s published MTD test cases before relying
          on it for live submissions.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Employees
            </CardTitle>
            <CardDescription>
              Onboard employees into payroll — capture statutory info,
              banking, salary, and statutory contributions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/admin/payroll/employees">Manage employees</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4" />
              Payroll Runs
            </CardTitle>
            <CardDescription>
              Create monthly payroll drafts, review payslips, submit, and
              attach approved claims as reimbursements.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/admin/payroll/runs">Open runs</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="h-4 w-4" />
              Settings
            </CardTitle>
            <CardDescription>
              OT multipliers, working-days rule, default EPF rates, Form
              E employer particulars.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/admin/payroll/settings">Open settings</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
