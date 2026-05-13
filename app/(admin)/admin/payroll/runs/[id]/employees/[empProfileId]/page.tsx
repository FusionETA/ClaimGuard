import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ChevronLeft, Sliders } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PayrollAdjustmentForm } from "@/components/admin/payroll-adjustment-form"
import { getPayrollAdjustmentPageData } from "@/modules/payroll/application/services/payroll-run.service"
import {
  PAYROLL_RUN_STATUS_LABELS,
  periodLabel,
} from "@/modules/payroll/domain/runs"

/**
 * /admin/payroll/runs/[id]/employees/[empProfileId]
 *
 * Per-employee adjustment form. Admins fill in:
 *   - OT hours (normal / rest day / public holiday)
 *   - One-off allowances + deductions for this run only
 *   - Unpaid-leave deduction (manual until leave integration ships)
 *   - Notes
 *
 * After saving, the admin returns to the run detail page and clicks
 * Regenerate to recompute the payslip with these adjustments folded
 * in.
 */
export default async function AdminPayrollAdjustmentPage({
  params,
}: {
  params: Promise<{ id: string; empProfileId: string }>
}) {
  const { id, empProfileId } = await params
  const data = await getPayrollAdjustmentPageData({
    runId: id,
    employeeProfileId: empProfileId,
  })
  if (!data) redirect(`/admin/payroll/runs/${id}` as Route)

  const isDraft = data.run.status === "DRAFT"

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/payroll/runs/${data.run.id}` as Route}>
              <ChevronLeft className="h-4 w-4" />
              Back to run
            </Link>
          </Button>
          <div className="space-y-0.5">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <Sliders className="h-5 w-5 text-primary" />
              {data.employee.name}
              <span className="text-sm font-normal text-muted-foreground">
                {data.employee.employeeCode}
              </span>
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.organizationName ? `${data.organizationName} · ` : ""}
              {periodLabel(data.run.periodYear, data.run.periodMonth)} ·{" "}
              {data.employee.jobTitle} ·{" "}
              {data.employee.salaryType === "MONTHLY"
                ? data.employee.monthlySalary != null
                  ? `RM ${data.employee.monthlySalary.toLocaleString("en-MY", { minimumFractionDigits: 2 })} / month`
                  : "monthly"
                : data.employee.hourlyRate != null
                  ? `RM ${data.employee.hourlyRate.toLocaleString("en-MY", { minimumFractionDigits: 2 })} / hour`
                  : "hourly"}
            </p>
          </div>
        </div>
        <Badge
          variant="outline"
          className={
            data.run.status === "SUBMITTED"
              ? "border-emerald-300/60 text-emerald-700"
              : "border-amber-300/60 text-amber-700"
          }
        >
          {PAYROLL_RUN_STATUS_LABELS[data.run.status]}
        </Badge>
      </div>

      <PayrollAdjustmentForm
        runId={data.run.id}
        employeeProfileId={data.employee.employeeProfileId}
        adjustment={data.adjustment}
        fixedAllowances={data.fixedAllowances}
        readOnly={!isDraft}
      />
    </div>
  )
}
