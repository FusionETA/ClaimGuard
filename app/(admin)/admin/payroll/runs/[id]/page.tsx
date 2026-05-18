import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import {
  ChevronLeft,
  ClipboardList,
  Download,
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
  ApprovePayrollRunButton,
  RetryXeroSyncButton,
  RevertPayrollRunButton,
  SendBackToDraftButton,
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
  // Excluded employees (salary = 0) are NOT in the "needs setup"
  // bucket — they're intentionally opted out, not broken. Keep them
  // visible in their own section so admins can see who's being
  // skipped and re-enable by editing the salary.
  const excluded = data.employees.filter(
    (e) => e.isExcluded && !e.isArchived,
  )
  const needsSetup = data.employees.filter(
    (e) => !e.ready && !e.isArchived && !e.isExcluded,
  )
  const isDraft = data.run.status === "DRAFT"
  const isPendingApproval = data.run.status === "PENDING_APPROVAL"
  const isSubmitted = data.run.status === "SUBMITTED"
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
              : data.run.status === "PENDING_APPROVAL"
                ? "border-sky-300/60 text-sky-700"
                : "border-amber-300/60 text-amber-700"
          }
        >
          {PAYROLL_RUN_STATUS_LABELS[data.run.status]}
        </Badge>
      </div>

      {/* The "Totals" card used to live here, duplicating every
          number the new payslips table already shows in its column
          headers + summary footer. Removed in favour of the single
          source of truth. The "no payroll results yet" empty state
          is preserved below in the no-employees-ready section.
          When data.payslips.length === 0 the table itself doesn't
          render — that's the empty signal now. */}
      {data.payslips.length === 0 && ready.length > 0 ? (
        <Card className="print:hidden">
          <CardHeader>
            <CardDescription>
              No payroll results yet. Click <strong>Run payroll</strong>{" "}
              to compute pay for every ready employee.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {isDraft && (needsSetup.length > 0 || readyMissingPayslip.length > 0) ? (
        <div className="print:hidden">
          <PayrollRunEmployeeTables
            runId={data.run.id}
            hasPayslips={data.payslips.length > 0}
            needsSetup={needsSetup}
            readyEmployees={readyMissingPayslip}
          />
        </div>
      ) : null}

      {isDraft && excluded.length > 0 ? (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="text-base">
              Excluded from this run
            </CardTitle>
            <CardDescription>
              {excluded.length} employee
              {excluded.length === 1 ? "" : "s"} with salary set to 0 —
              skipped from payroll. Edit their salary to include them.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="divide-y divide-border/40 text-sm">
              {excluded.map((e) => (
                <li
                  key={e.employeeProfileId}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {e.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {e.employeeId} · {e.jobTitle}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      variant="outline"
                      className="border-slate-300/60 text-[10px] text-slate-600"
                    >
                      Excluded
                    </Badge>
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        href={`/admin/payroll/employees/${e.userId}` as Route}
                      >
                        Edit
                      </Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {data.payslips.length > 0 ? (
        <PayslipsListPanel
          runId={data.run.id}
          payslips={data.payslips}
          showAdjustLink
          runIsDraft={isDraft}
        />
      ) : null}

      {/* The Payroll Summary PDF download lives in the payslips
          card header now — clicking it triggers `window.print()`,
          which renders the payslips table + summary footer exactly
          as drawn on screen (single source of truth). The previous
          server-side PDF endpoint at /summary/route.ts is unused. */}

      {(data.attachments.length > 0 ||
        (isDraft && data.attachableClaims.length > 0)) && (
        <Card className="print:hidden">
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
                  No reviewed personally-paid claims to attach.
                  Approve a claim and add it from{" "}
                  <Link
                    href="/admin/claims/payroll-ready"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Ready for payroll
                  </Link>{" "}
                  first.
                </p>
              )}
          </CardContent>
        </Card>
      )}

      {ready.length === 0 && data.payslips.length === 0 && (
        <Card className="print:hidden">
          <CardHeader>
            <CardDescription>
              No employees ready for payroll. Complete an
              employee&apos;s payroll profile to include them on the
              next run.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Rejection-reason banner — shown only on DRAFT runs that
          carry a non-empty `approvalRejectionReason`, i.e. an approver
          previously bounced this run back. Cleared when the admin
          re-submits for approval (the repo nulls the column on
          submitForApproval). Helps the submitter remember what to
          fix without hunting through Slack. */}
      {isDraft && data.run.approvalRejectionReason ? (
        <Card className="border-rose-300/60 bg-rose-50/40 dark:border-rose-700/40 dark:bg-rose-950/20 print:hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-rose-900 dark:text-rose-200">
              <ClipboardList className="h-4 w-4" />
              Sent back to draft
            </CardTitle>
            <CardDescription className="text-rose-900/80 dark:text-rose-200/80">
              An approver bounced this run back. Reason:{" "}
              <span className="font-medium">
                {data.run.approvalRejectionReason}
              </span>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* Stale-data banner — shown only when the run has payslips and
          the admin has edited adjustments / claim attachments since
          the last Generate. Blocks Submit until they re-run so the
          payslips reflect the latest figures. */}
      {isDraft && data.isStale ? (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-amber-900 dark:text-amber-200">
              <ClipboardList className="h-4 w-4" />
              Run payroll again before submitting
            </CardTitle>
            <CardDescription className="text-amber-900/80 dark:text-amber-200/80">
              You&apos;ve changed OT hours, one-off line items, or
              reimbursements since the last payroll calculation. The
              numbers shown on the table reflect the earlier state.
              Click <strong>Run payroll</strong> to regenerate before
              submitting.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {isDraft && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DeletePayrollRunDraftButton runId={data.run.id} />
          <div className="flex flex-wrap items-center gap-2">
            <GeneratePayslipsButton
              runId={data.run.id}
              hasExisting={data.payslips.length > 0}
            />
            {data.payslips.length > 0 && (
              <SubmitPayrollRunButton
                runId={data.run.id}
                disabled={data.isStale}
                disabledHint="Re-run payroll first so the payslips reflect your latest changes."
              />
            )}
          </div>
        </div>
      )}

      {isPendingApproval && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Awaiting approval
            {data.run.submittedForApprovalAt
              ? ` since ${new Date(data.run.submittedForApprovalAt).toLocaleString()}`
              : ""}
            . The run is locked from edits — approve to release payslips,
            or send it back to draft to make changes.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <SendBackToDraftButton runId={data.run.id} />
            <ApprovePayrollRunButton runId={data.run.id} />
          </div>
        </div>
      )}

      {isSubmitted && (
        <>
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

          {/* Xero sync status. Renders three states:
                • SYNCED → green pill with journal number + sync time
                • ERROR  → red banner with the captured error + retry
                • NOT_SYNCED → grey hint that sync didn't fire (admin
                              disabled it or mapping was missing)
              All three are skipped when the run has been reverted and
              never synced — the absence of any Xero status is a valid
              empty state.
          */}
          {data.run.xeroSyncStatus === "SYNCED" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50/40 p-3 dark:border-emerald-700/40 dark:bg-emerald-950/20">
              <div className="text-xs">
                <p className="font-medium text-foreground">
                  Posted to Xero
                </p>
                <p className="text-muted-foreground">
                  Journal{" "}
                  <span className="font-mono">
                    {data.run.xeroJournalNumber ??
                      data.run.xeroManualJournalId}
                  </span>
                  {data.run.xeroSyncedAt
                    ? ` · synced ${new Date(
                        data.run.xeroSyncedAt,
                      ).toLocaleString()}`
                    : ""}
                </p>
              </div>
            </div>
          ) : null}

          {data.run.xeroSyncStatus === "ERROR" ? (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
              <div className="min-w-0 text-xs">
                <p className="font-medium text-destructive">
                  Xero sync failed
                </p>
                <p className="mt-0.5 break-words text-muted-foreground">
                  {data.run.xeroSyncError ?? "Unknown error."}
                </p>
              </div>
              <RetryXeroSyncButton runId={data.run.id} />
            </div>
          ) : null}

          {data.run.xeroSyncStatus === "NOT_SYNCED" &&
          !data.run.xeroManualJournalId ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                Not posted to Xero. Sync was disabled or the mapping was
                incomplete when this run was approved.
              </p>
              <RetryXeroSyncButton runId={data.run.id} />
            </div>
          ) : null}
        </>
      )}
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
