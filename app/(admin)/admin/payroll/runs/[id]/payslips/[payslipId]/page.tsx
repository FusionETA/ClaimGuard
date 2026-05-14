import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronLeft, FileText } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PrintPayslipButton } from "@/components/admin/print-payslip-button"
import { PayslipPrintStyles } from "@/components/admin/payslip-print-styles"
import { getPayrollPayslipDetailPageData } from "@/modules/payroll/application/services/payroll-run.service"
import {
  PAYROLL_RUN_STATUS_LABELS,
  periodLabel,
  type PayslipData,
  type PayslipLineItemData,
} from "@/modules/payroll/domain/runs"
import {
  SALARY_TYPE_LABELS,
  type SalaryType,
} from "@/modules/payroll/domain/models"

/**
 * /admin/payroll/runs/[id]/payslips/[payslipId]
 *
 * Per-employee payslip view. Displays the frozen snapshot, the
 * computed numbers (basic/OT/allowances/deductions/statutory), and
 * the line items in their respective groups.
 */
export default async function AdminPayrollPayslipDetailPage({
  params,
}: {
  params: Promise<{ id: string; payslipId: string }>
}) {
  const { id, payslipId } = await params
  const data = await getPayrollPayslipDetailPageData({ payslipId })
  if (!data || data.payslip.payrollRunId !== id) {
    redirect(`/admin/payroll/runs/${id}`)
  }

  const { payslip, run } = data
  const allowances = payslip.lineItems.filter((li) => li.kind === "ALLOWANCE")
  const deductions = payslip.lineItems.filter((li) => li.kind === "DEDUCTION")
  const reimbursements = payslip.lineItems.filter(
    (li) => li.kind === "REIMBURSEMENT",
  )

  return (
    <div className="space-y-6 print:space-y-3" id="payslip-print-root">
      <PayslipPrintStyles
        title={`Payslip — ${payslip.snapshotName} — ${periodLabel(run.periodYear, run.periodMonth)}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/payroll/runs/${run.id}`}>
              <ChevronLeft className="h-4 w-4" />
              Back to run
            </Link>
          </Button>
          <div className="space-y-0.5">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <FileText className="h-5 w-5 text-primary" />
              {payslip.snapshotName}
              <span className="text-sm font-normal text-muted-foreground">
                {payslip.snapshotEmployeeId}
              </span>
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.organizationName ? `${data.organizationName} · ` : ""}
              {periodLabel(run.periodYear, run.periodMonth)} ·{" "}
              {payslip.snapshotPosition ?? "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              run.status === "SUBMITTED"
                ? "border-emerald-300/60 text-emerald-700"
                : "border-amber-300/60 text-amber-700"
            }
          >
            {PAYROLL_RUN_STATUS_LABELS[run.status]}
          </Badge>
          <PrintPayslipButton />
        </div>
      </div>

      {/* Print-only header — minimal employer/employee identity block.
          Hidden on screen because the regular header carries the same
          info there. */}
      <div className="hidden print:block">
        <div className="border-b border-border pb-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Payslip
          </div>
          <div className="mt-1 text-lg font-semibold">
            {data.organizationName || "—"}
          </div>
          <div className="mt-1 text-sm">
            {payslip.snapshotName} · {payslip.snapshotEmployeeId} ·{" "}
            {payslip.snapshotPosition ?? "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            Period: {periodLabel(run.periodYear, run.periodMonth)}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Snapshot</CardTitle>
          <CardDescription>
            Frozen at the time of generation. Edits to the employee&apos;s
            payroll profile won&apos;t change historical payslips —
            regenerate to recompute.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 text-sm">
          <SnapshotRow
            label="Salary type"
            value={SALARY_TYPE_LABELS[payslip.snapshotSalaryType as SalaryType]}
          />
          {payslip.snapshotSalaryType === "MONTHLY" ? (
            <SnapshotRow
              label="Monthly salary"
              value={
                payslip.snapshotMonthlySalary != null
                  ? formatMyr(payslip.snapshotMonthlySalary)
                  : "—"
              }
            />
          ) : (
            <SnapshotRow
              label="Hourly rate"
              value={
                payslip.snapshotHourlyRate != null
                  ? formatMyr(payslip.snapshotHourlyRate)
                  : "—"
              }
            />
          )}
          <SnapshotRow
            label="Nationality"
            value={payslip.snapshotNationality ?? "—"}
          />
          <SnapshotRow
            label="Tax resident"
            value={payslip.snapshotIsResident ? "Yes" : "No"}
          />
          <SnapshotRow
            label="EPF employee rate"
            value={`${payslip.snapshotEpfRates.employee}%`}
          />
          <SnapshotRow
            label="EPF employer rate"
            value={`${payslip.snapshotEpfRates.employer}%`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Earnings</CardTitle>
          <CardDescription>
            Basic, OT, and allowances.{" "}
            {payslip.proratedFactor < 1
              ? `Prorated to ${(payslip.proratedFactor * 100).toFixed(2)}% (${payslip.proratedDays}/${payslip.totalWorkingDays} working days).`
              : "Full month."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Line label="Basic" value={payslip.basicPay} muted />
          <Line label="Prorated basic" value={payslip.proratedPay} />
          {(payslip.otNormalHours > 0 ||
            payslip.otRestHours > 0 ||
            payslip.otPublicHours > 0 ||
            payslip.otPay > 0) && (
            <>
              <Line label="OT — Normal hours" value={payslip.otNormalHours} currency={false} muted />
              <Line label="OT — Rest hours" value={payslip.otRestHours} currency={false} muted />
              <Line label="OT — Public holiday hours" value={payslip.otPublicHours} currency={false} muted />
              <Line label="OT pay" value={payslip.otPay} />
            </>
          )}
          {allowances.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/30">
              <div className="border-b border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Allowances
              </div>
              <div className="space-y-1 px-3 py-2">
                {allowances.map((li) => (
                  <LineItemRow key={li.id} item={li} />
                ))}
              </div>
            </div>
          )}
          {reimbursements.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/30">
              <div className="border-b border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Reimbursements (from claims)
              </div>
              <div className="space-y-1 px-3 py-2">
                {reimbursements.map((li) => (
                  <LineItemRow key={li.id} item={li} />
                ))}
              </div>
            </div>
          )}
          <div className="border-t border-border pt-3">
            <Line label="Gross pay" value={payslip.grossPay} bold />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deductions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Line label="EPF (employee)" value={payslip.epfEmployee} />
          <Line label="SOCSO (employee)" value={payslip.socsoEmployee} />
          <Line label="EIS (employee)" value={payslip.eisEmployee} />
          <Line
            label="PCB (income tax)"
            value={payslip.pcb}
            muted={payslip.pcb === 0}
          />
          <Line label="Zakat" value={payslip.zakat} muted />
          {/* Unpaid leave shows up in the `Manual deductions` block
              below as a `deduct_unpaid_leave` line item — no longer
              its own row. */}
          {deductions.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/30">
              <div className="border-b border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Manual deductions
              </div>
              <div className="space-y-1 px-3 py-2">
                {deductions.map((li) => (
                  <LineItemRow key={li.id} item={li} />
                ))}
              </div>
            </div>
          )}
          <div className="border-t border-border pt-3">
            <Line label="Net pay" value={payslip.netPay} bold />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Employer contributions</CardTitle>
          <CardDescription>
            Costs borne by the employer on top of gross pay.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Line label="EPF (employer)" value={payslip.epfEmployer} />
          <Line label="SOCSO (employer)" value={payslip.socsoEmployer} />
          <Line label="EIS (employer)" value={payslip.eisEmployer} />
          <Line
            label="HRDF (HRD Corp levy)"
            value={payslip.hrdf}
            muted={payslip.hrdf === 0}
          />
          <div className="border-t border-border pt-3">
            <Line
              label="Total cost to employer"
              value={payslip.totalCostToEmployer}
              bold
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium text-foreground">{value}</div>
    </div>
  )
}

function Line({
  label,
  value,
  bold,
  muted,
  currency = true,
}: {
  label: string
  value: number
  bold?: boolean
  muted?: boolean
  currency?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        muted ? "text-muted-foreground" : "text-foreground"
      }`}
    >
      <span>{label}</span>
      <span className={bold ? "text-base font-semibold" : ""}>
        {currency ? formatMyr(value) : value.toString()}
      </span>
    </div>
  )
}

function LineItemRow({ item }: { item: PayslipLineItemData }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="truncate text-foreground">{item.label}</span>
      <span className="font-medium text-foreground">
        {formatMyr(item.amount)}
      </span>
    </div>
  )
}

function formatMyr(value: number) {
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 2,
  }).format(value)
}
