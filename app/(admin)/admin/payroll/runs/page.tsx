import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronRight, FileText } from "lucide-react"

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
import { PayrollYtdImportDialog } from "@/components/admin/payroll-ytd-import-dialog"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"
import {
  getPayrollRunsPageData,
  listMembersForPolicies,
} from "@/modules/payroll/application/services/payroll-run.service"
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
  await requireAdminModule("payroll")
  const data = await getPayrollRunsPageData()
  if (!data) redirect("/admin")

  const drafts = data.runs.filter((r) => r.status === "DRAFT")
  const pendingApproval = data.runs.filter(
    (r) => r.status === "PENDING_APPROVAL",
  )
  // Split SUBMITTED runs by origin so imported migration history sits
  // in its own card — engine-computed payroll history shouldn't be
  // visually mixed with manually-typed YTD entries.
  const submitted = data.runs.filter(
    (r) => r.status === "SUBMITTED" && r.source !== "IMPORTED",
  )
  const imported = data.runs.filter(
    (r) => r.status === "SUBMITTED" && r.source === "IMPORTED",
  )
  const defaultPeriod = currentPeriod()

  // Preload the picker's per-policy member lists — the New Draft
  // dialog expands them inline so the admin can uncheck individuals
  // without opening a per-policy fetch on click. Empty when the admin
  // has no accessible policies (the picker button is already disabled
  // in that case).
  const membersByPolicy = await listMembersForPolicies({
    policyIds: data.availablePolicies.map((p) => p.id),
  })

  return (
    <div className="space-y-6">
      <header className="space-y-1">
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
            Pick the period for a new draft, or import historical
            payroll runs from a previous system (mid-year migrations).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <NewPayrollRunForm
            defaultYear={defaultPeriod.year}
            defaultMonth={defaultPeriod.month}
            availablePolicies={data.availablePolicies}
            membersByPolicy={membersByPolicy}
          />
          <PayrollYtdImportDialog defaultYear={defaultPeriod.year} />
        </CardContent>
      </Card>

      {pendingApproval.length > 0 && (
        <Card className="border-sky-300/60 bg-sky-50/40 dark:border-sky-700/40 dark:bg-sky-950/20">
          <CardHeader>
            <CardTitle className="text-base text-sky-900 dark:text-sky-200">
              Awaiting approval
            </CardTitle>
            <CardDescription className="text-sky-900/80 dark:text-sky-200/80">
              These runs have been submitted for review. Open one to
              approve it (payslips go live to employees) or send it
              back to draft for edits.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {pendingApproval.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </CardContent>
        </Card>
      )}

      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Drafts</CardTitle>
            <CardDescription>
              Editable runs. Run payroll and review totals before
              submitting for approval.
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

      {/* Migration-imported history sits in its own card so the audit
          trail clearly separates engine-produced runs from numbers an
          admin typed in during a mid-year cutover. */}
      {imported.length > 0 && (
        <Card className="border-violet-300/60 bg-violet-50/30 dark:border-violet-700/40 dark:bg-violet-950/20">
          <CardHeader>
            <CardTitle className="text-base text-violet-900 dark:text-violet-200">
              Imported runs
            </CardTitle>
            <CardDescription className="text-violet-900/80 dark:text-violet-200/80">
              Seeded from a YTD migration upload. Payslip numbers come
              from the uploaded XLSX as-typed by the admin, not the calc
              engine.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {imported.map((run) => (
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
              run payroll, review totals, and submit when ready.
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
          {run.status === "SUBMITTED" && run.submittedAt
            ? ` · submitted ${new Date(run.submittedAt).toLocaleDateString()}`
            : run.status === "PENDING_APPROVAL" && run.submittedForApprovalAt
              ? ` · awaiting approval since ${new Date(run.submittedForApprovalAt).toLocaleDateString()}`
              : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={
            run.status === "SUBMITTED"
              ? "border-emerald-300/60 text-[10px] text-emerald-700"
              : run.status === "PENDING_APPROVAL"
                ? "border-sky-300/60 text-[10px] text-sky-700"
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
