import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ChevronLeft, FileText } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DownloadPayslipButton } from "@/components/payroll/download-payslip-button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PayslipPrintStyles } from "@/components/admin/payslip-print-styles"
import { PrintPayslipButton } from "@/components/admin/print-payslip-button"
import { getEmployeePayslipDetailPageData } from "@/modules/payroll/application/services/employee-payroll.service"
import { periodLabel } from "@/modules/payroll/domain/runs"
import type { PayslipLineItemData } from "@/modules/payroll/domain/runs"
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  SALARY_TYPE_LABELS,
  type PayrollAdjustmentCategory,
  type SalaryType,
} from "@/modules/payroll/domain/models"

/**
 * Split allowance line items into cash vs non-cash (BIK). The category
 * meta tells us which is which — see `nonCash` flag in domain/models.ts.
 * Line items without a known category default to cash (legacy / free-form).
 */
function isNonCashAllowance(category: string | null | undefined): boolean {
  if (!category) return false
  const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[category as PayrollAdjustmentCategory]
  return Boolean(meta?.nonCash)
}

/**
 * /employee/payslips/[id] — employee-facing payslip detail. Same
 * layout as the admin detail page but scoped strictly to the
 * logged-in employee's own SUBMITTED payslips.
 */
export default async function EmployeePayslipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getEmployeePayslipDetailPageData({ payslipId: id })
  if (!data) redirect("/employee/payslips" as Route)

  const { payslip, run } = data
  // Cash allowances feed gross pay. Non-cash BIK items are listed
  // separately under "Benefits in Kind" since they're disclosed for
  // tax purposes but the employee doesn't receive them in cash.
  const allowances = payslip.lineItems.filter(
    (li) => li.kind === "ALLOWANCE" && !isNonCashAllowance(li.category),
  )
  const benefitsInKind = payslip.lineItems.filter(
    (li) => li.kind === "ALLOWANCE" && isNonCashAllowance(li.category),
  )
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
            <Link href={"/employee/payslips" as Route}>
              <ChevronLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          <div className="space-y-0.5">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <FileText className="h-5 w-5 text-primary" />
              {periodLabel(run.periodYear, run.periodMonth)}
            </h1>
            <p className="text-xs text-muted-foreground">
              {payslip.snapshotName} · {payslip.snapshotEmployeeId} ·{" "}
              {payslip.snapshotPosition ?? "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DownloadPayslipButton payslipId={id} />
          <PrintPayslipButton />
        </div>
      </div>

      {/* Print-only header — minimal identity block. Hidden on screen
          because the regular header carries the same info there. */}
      <div className="hidden print:block">
        <div className="border-b border-border pb-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Payslip
          </div>
          <div className="mt-1 text-lg font-semibold">
            {payslip.snapshotName}
          </div>
          <div className="mt-1 text-sm">
            {payslip.snapshotEmployeeId} · {payslip.snapshotPosition ?? "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            Period: {periodLabel(run.periodYear, run.periodMonth)}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Earnings</CardTitle>
          <CardDescription>
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
            <LineItemGroup label="Allowances" items={allowances} />
          )}
          {reimbursements.length > 0 && (
            <LineItemGroup
              label="Reimbursements"
              items={reimbursements}
            />
          )}
          <div className="border-t border-border pt-3">
            <Line label="Gross pay" value={payslip.grossPay} bold />
          </div>
          {benefitsInKind.length > 0 && (
            <>
              <LineItemGroup label="Benefits in Kind" items={benefitsInKind} />
              <div className="rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                Benefits in Kind are non-cash (e.g. company car,
                accommodation) and are NOT paid as part of your gross
                salary. They are disclosed here for tax purposes — your
                taxable income is {payslip.totalBenefitsInKind > 0 ? "the sum of Gross pay and Benefits in Kind" : "your Gross pay"}.
              </div>
              <div className="border-t border-border pt-3">
                <Line
                  label="Taxable income (for PCB)"
                  value={payslip.grossPay + payslip.totalBenefitsInKind}
                  bold
                />
              </div>
            </>
          )}
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
          {/* SKBBK (Skim LINDUNG 24 Jam) — employee-only PERKESO
              scheme, effective 1 Jun 2026. Only shown when the
              employee actually contributes so pre-June payslips
              (and non-opted-in employees) don't display a junk
              RM 0.00 line. */}
          {payslip.skbbkEmployee > 0 && (
            <Line label="SKBBK (employee)" value={payslip.skbbkEmployee} />
          )}
          <Line
            label="PCB (income tax)"
            value={payslip.pcb}
            muted={payslip.pcb === 0}
          />
          {payslip.zakat > 0 && <Line label="Zakat" value={payslip.zakat} />}
          {/* Unpaid leave shows up under "Other deductions" below as a
              `deduct_unpaid_leave` line item. */}
          {deductions.length > 0 && (
            <LineItemGroup label="Other deductions" items={deductions} />
          )}
          <div className="border-t border-border pt-3">
            <Line label="Net pay" value={payslip.netPay} bold />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Salary basis</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 text-sm">
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

function LineItemGroup({
  label,
  items,
}: {
  label: string
  items: PayslipLineItemData[]
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30">
      <div className="border-b border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1 px-3 py-2">
        {items.map((li) => (
          <div
            key={li.id}
            className="flex items-center justify-between text-sm"
          >
            <span className="truncate text-foreground">{li.label}</span>
            <span className="font-medium text-foreground">
              {formatMyr(li.amount)}
            </span>
          </div>
        ))}
      </div>
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
