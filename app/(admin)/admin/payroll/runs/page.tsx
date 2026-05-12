import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronRight, ClipboardList, FileText } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { NewPayrollRunForm } from "@/components/admin/new-payroll-run-form"
import { getPayrollRunsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import {
  PAYROLL_RUN_STATUS_LABELS,
  currentPeriod,
  periodLabel,
  type PayrollRunRow,
} from "@/modules/payroll/domain/runs"

/**
 * /admin/payroll/runs
 *
 * Lists all payroll runs (Draft + Submitted) for the active org and
 * provides a period picker to create a new draft.
 */
export default async function AdminPayrollRunsPage() {
  const data = await getPayrollRunsPageData()
  if (!data) redirect("/admin")

  const drafts = data.runs.filter((r) => r.status === "DRAFT")
  const submitted = data.runs.filter((r) => r.status === "SUBMITTED")
  const defaultPeriod = currentPeriod()

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
          <ClipboardList className="h-6 w-6 text-primary" />
          Payroll Runs
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.organizationName ? `${data.organizationName} — ` : ""}
          {data.eligibleEmployeeCount} employee
          {data.eligibleEmployeeCount === 1 ? "" : "s"} ready for payroll ·{" "}
          {data.runs.length} run{data.runs.length === 1 ? "" : "s"} on file
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Start a new run</CardTitle>
          <CardDescription>
            Pick the period (month + year). A draft is created and you can
            generate payslips on the next page. One draft per period.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewPayrollRunForm
            defaultYear={defaultPeriod.year}
            defaultMonth={defaultPeriod.month}
          />
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Drafts</CardTitle>
            <CardDescription>
              Editable runs. Generate payslips and review totals before
              submitting.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {drafts.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </CardContent>
        </Card>
      )}

      {submitted.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Submitted</CardTitle>
            <CardDescription>
              Finalised runs. Payslips are locked and historical totals
              are preserved.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {submitted.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </CardContent>
        </Card>
      )}

      {data.runs.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              No payroll runs yet
            </CardTitle>
            <CardDescription>
              Pick a period above to create your first draft. You can
              generate payslips, review totals, and submit when ready.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin/payroll/employees">Review employees</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RunRow({ run }: { run: PayrollRunRow }) {
  return (
    <Link
      href={`/admin/payroll/runs/${run.id}`}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-primary/5"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {periodLabel(run.periodYear, run.periodMonth)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {run.payslipCount} payslip{run.payslipCount === 1 ? "" : "s"}
          {run.submittedAt
            ? ` · submitted ${new Date(run.submittedAt).toLocaleDateString()}`
            : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={
            run.status === "SUBMITTED"
              ? "border-emerald-300/60 text-[10px] text-emerald-700"
              : "border-amber-300/60 text-[10px] text-amber-700"
          }
        >
          {PAYROLL_RUN_STATUS_LABELS[run.status]}
        </Badge>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </Link>
  )
}
