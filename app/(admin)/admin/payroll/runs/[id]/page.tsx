import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import {
  ChevronLeft,
  ClipboardList,
  Download,
  FileText,
  Receipt,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  AttachClaimButton,
  DetachClaimButton,
} from "@/components/admin/claim-attachment-buttons"
import { DeletePayrollRunDraftButton } from "@/components/admin/delete-payroll-run-draft-button"
import { GeneratePayslipsButton } from "@/components/admin/generate-payslips-button"
import { PayrollRunEmployeeTables } from "@/components/admin/payroll-run-employee-tables"
import { PayslipsListPanel } from "@/components/admin/payslip-list-panel"
import {
  RevertPayrollRunButton,
  SubmitPayrollRunButton,
} from "@/components/admin/submit-payroll-run-buttons"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import {
  PAYROLL_RUN_STATUS_LABELS,
  periodLabel,
  type AttachableClaimRow,
  type PayrollRunClaimRow,
} from "@/modules/payroll/domain/runs"

/**
 * /admin/payroll/runs/[id]
 *
 * Run detail. Phase 4 scope:
 *   - Cached totals card (real numbers after Generate)
 *   - List of payslips already generated (per-employee links)
 *   - Needs-setup warning for incomplete profiles
 *   - Will-be-included list (employees ready but not yet on a payslip)
 *   - Generate / Regenerate payslips button
 *   - Delete-draft button (DRAFT only)
 *
 * Submit-and-finalise lands in Phase 6.
 */
export default async function AdminPayrollRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getPayrollRunDetailWithPayslipsPageData({ runId: id })
  if (!data) redirect("/admin/payroll/runs")

  const ready = data.employees.filter((e) => e.ready)
  const needsSetup = data.employees.filter((e) => !e.ready && !e.isArchived)
  const isDraft = data.run.status === "DRAFT"
  const onPayslip = new Set(data.payslips.map((p) => p.employeeProfileId))
  const readyMissingPayslip = ready.filter(
    (e) => !onPayslip.has(e.employeeProfileId),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/payroll/runs">
              <ChevronLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          <div className="space-y-0.5">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <ClipboardList className="h-5 w-5 text-primary" />
              {periodLabel(data.run.periodYear, data.run.periodMonth)}
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.organizationName ? `${data.organizationName} · ` : ""}
              {data.run.payslipCount} payroll result
              {data.run.payslipCount === 1 ? "" : "s"} on file
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Totals</CardTitle>
          <CardDescription>
            {data.payslips.length === 0
              ? "No payroll results yet. Click Run payroll to compute pay for every ready employee."
              : isDraft
                ? "Computed from the latest payroll run. Re-run payroll after editing profiles or settings."
                : "Final totals from the submitted run."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Stat label="Gross pay" value={data.run.totalGross} />
          <Stat label="Net pay" value={data.run.totalNet} />
          <Stat label="Employee EPF" value={data.run.totalEmployeeEpf} />
          <Stat label="Employer EPF" value={data.run.totalEmployerEpf} />
          <Stat label="Employee SOCSO" value={data.run.totalEmployeeSocso} />
          <Stat label="Employer SOCSO" value={data.run.totalEmployerSocso} />
          <Stat label="Employee EIS" value={data.run.totalEmployeeEis} />
          <Stat label="Employer EIS" value={data.run.totalEmployerEis} />
          <Stat label="PCB (income tax)" value={data.run.totalPcb} />
          <Stat label="HRDF (employer)" value={data.run.totalHrdf} />
          <Stat
            label="Total cost to employer"
            value={data.run.totalCostToEmployer}
          />
          <Stat
            label="Employees"
            value={data.run.employeeCount}
            currency={false}
          />
        </CardContent>
      </Card>

      {isDraft && (needsSetup.length > 0 || readyMissingPayslip.length > 0) ? (
        <PayrollRunEmployeeTables
          runId={data.run.id}
          hasPayslips={data.payslips.length > 0}
          needsSetup={needsSetup}
          readyEmployees={readyMissingPayslip}
        />
      ) : null}

      {data.payslips.length > 0 ? (
        <PayslipsListPanel
          runId={data.run.id}
          payslips={data.payslips}
          showAdjustLink={isDraft}
        />
      ) : null}

      {data.payslips.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              Payroll summary PDF
            </CardTitle>
            <CardDescription>
              Attached to this run from the latest payroll calculation.
              Re-run payroll after changing profiles or settings to
              refresh the numbers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="gap-2">
              <a
                href={`/admin/payroll/runs/${data.run.id}/summary`}
                download
              >
                <Download className="h-4 w-4" />
                Download summary PDF
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {(data.attachments.length > 0 ||
        (isDraft && data.attachableClaims.length > 0)) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Receipt className="h-4 w-4" />
              Reimbursements
            </CardTitle>
            <CardDescription>
              Approved claims that get paid out alongside salary. Pay
              amount is snapshotted at attach time, so later edits to
              the claim don&apos;t change historical payroll figures.
              {data.attachments.length > 0 && isDraft
                ? " Re-run payroll after attaching to refresh the totals."
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.attachments.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Attached to this run
                </div>
                {data.attachments.map((a) => (
                  <AttachedRow
                    key={a.id}
                    runId={data.run.id}
                    attachment={a}
                    canDetach={isDraft}
                  />
                ))}
              </div>
            )}
            {isDraft && data.attachableClaims.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Available to attach
                </div>
                {data.attachableClaims.map((c) => (
                  <AttachableRow
                    key={c.claimId}
                    runId={data.run.id}
                    claim={c}
                  />
                ))}
              </div>
            )}
            {isDraft &&
              data.attachments.length === 0 &&
              data.attachableClaims.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No reviewed + synced + personally-paid claims to
                  attach. Approve and sync a claim from{" "}
                  <Link
                    href="/admin/claims/sync"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Ready to sync
                  </Link>{" "}
                  first.
                </p>
              )}
          </CardContent>
        </Card>
      )}

      {ready.length === 0 && data.payslips.length === 0 && (
        <Card>
          <CardHeader>
            <CardDescription>
              No employees ready for payroll. Complete an
              employee&apos;s payroll profile to include them on the
              next run.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {isDraft && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DeletePayrollRunDraftButton runId={data.run.id} />
          <div className="flex flex-wrap items-center gap-2">
            <GeneratePayslipsButton
              runId={data.run.id}
              hasExisting={data.payslips.length > 0}
            />
            {data.payslips.length > 0 && (
              <SubmitPayrollRunButton runId={data.run.id} />
            )}
          </div>
        </div>
      )}

      {!isDraft && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Submitted
            {data.run.submittedAt
              ? ` on ${new Date(data.run.submittedAt).toLocaleString()}`
              : ""}
            . Payslips are visible to employees.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" className="gap-2">
              <a
                href={`/admin/payroll/runs/${data.run.id}/disbursement`}
                download
              >
                <Download className="h-4 w-4" />
                Download bank CSV
              </a>
            </Button>
            <RevertPayrollRunButton runId={data.run.id} />
          </div>
        </div>
      )}
    </div>
  )
}

function Stat(props: {
  label: string
  value: number | null
  currency?: boolean
}) {
  const currency = props.currency ?? true
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-base font-semibold text-foreground">
        {props.value == null
          ? "—"
          : currency
            ? formatMyr(props.value)
            : String(props.value)}
      </div>
    </div>
  )
}

function AttachedRow({
  runId,
  attachment,
  canDetach,
}: {
  runId: string
  attachment: PayrollRunClaimRow
  canDetach: boolean
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {attachment.label}
          <span className="ml-2 text-xs text-muted-foreground">
            {attachment.claimNumber}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {attachment.employeeName} · {attachment.employeeCode} ·{" "}
          {attachment.claimCategory}
          {attachment.claimType === "MILEAGE" ? " (mileage)" : ""}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">
          {formatMyr(attachment.amount)}
        </span>
        {canDetach && (
          <DetachClaimButton runId={runId} claimId={attachment.claimId} />
        )}
      </div>
    </div>
  )
}

function AttachableRow({
  runId,
  claim,
}: {
  runId: string
  claim: AttachableClaimRow
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-primary/5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {claim.title}
          <span className="ml-2 text-xs text-muted-foreground">
            {claim.claimNumber}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {claim.employeeName} · {claim.employeeCode} · {claim.category}
          {claim.claimType === "MILEAGE" ? " (mileage)" : ""} ·{" "}
          {new Date(claim.spentAt).toLocaleDateString()}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">
          {formatMyr(claim.amount)}
        </span>
        <AttachClaimButton runId={runId} claimId={claim.claimId} />
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
