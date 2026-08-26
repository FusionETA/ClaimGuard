import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import {
  ChevronLeft,
  ClipboardList,
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
import {
  AttachLeaveCashoutButton,
  DetachLeaveCashoutButton,
} from "@/components/admin/leave-cashout-buttons"
import { DeleteImportedRunButton } from "@/components/admin/delete-imported-run-button"
import { DeletePayrollRunDraftButton } from "@/components/admin/delete-payroll-run-draft-button"
import { DownloadPayrollSummaryButton } from "@/components/admin/download-payroll-summary-button"
import { GeneratePayslipsButton } from "@/components/admin/generate-payslips-button"
import { ImportPayrollAdjustmentsDialog } from "@/components/admin/import-payroll-adjustments-dialog"
import { PayrollDownloadsModal } from "@/components/admin/payroll-downloads-modal"
import { PayrollRunEmployeeTables } from "@/components/admin/payroll-run-employee-tables"
import { PayrollRunContentTabs } from "@/components/admin/payroll-run-content-tabs"
import { PayslipsListPanel } from "@/components/admin/payslip-list-panel"
import {
  ApprovePayrollRunButton,
  RetryXeroSyncButton,
  RevertPayrollRunButton,
  SendBackToDraftButton,
  SubmitPayrollRunButton,
} from "@/components/admin/submit-payroll-run-buttons"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  getActiveAdminPolicyScope,
  requireAdminModule,
} from "@/modules/organization/application/services/admin-access.service"
import { getPayrollReportsModalData } from "@/modules/payroll/application/services/payroll-reports.service"
import { getPayrollRunReadiness } from "@/modules/payroll/application/services/payroll-readiness.service"
import { getXeroConnectionSummary } from "@/modules/organization/application/services/xero-connection.service"
import {
  getLaterSubmittedRunsForRevert,
  getPayrollRunDetailWithPayslipsPageData,
  type PendingLeaveCashout,
} from "@/modules/payroll/application/services/payroll-run.service"
import { getSalaryChangeHintsForRun } from "@/modules/payroll/application/services/salary-change-hints.service"
import { SalaryChangeHintsCard } from "@/components/admin/salary-change-hints-card"
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
  await requireAdminModule("payroll")
  const data = await getPayrollRunDetailWithPayslipsPageData({ runId: id })
  if (!data) redirect("/admin/payroll/runs")

  // Whether the active org actually has a Xero connection. Drives
  // visibility of the "Posted to Xero" / "Not posted to Xero" panels
  // below — for orgs with no connection at all, those panels are
  // meaningless (and the Retry button calls a sync that would fail
  // anyway). `connections.length > 0` is the simplest "is connected"
  // signal that doesn't require checking token expiry.
  const session = await getCurrentSession()
  const activeOrgId = session ? resolveActiveOrgId(session) : undefined
  const xeroSummary = await getXeroConnectionSummary(activeOrgId)
  const hasXeroConnection =
    xeroSummary.configured && xeroSummary.connections.length > 0

  // Modal data — only meaningful once the run is SUBMITTED (the
  // statutory files + cached PDFs all require finalised payslips). We
  // still fetch it so the modal can render the empty state cleanly.
  const reportsModalData =
    data.run.status === "SUBMITTED"
      ? await getPayrollReportsModalData({ runId: id })
      : null

  // Later submitted months that a revert of this run would also cascade
  // back to draft — surfaced in the revert confirm modal.
  const revertCascadeMonths =
    data.run.status === "SUBMITTED"
      ? await getLaterSubmittedRunsForRevert({ runId: id })
      : []

  // Statutory readiness — fetched only on DRAFT runs (the only state
  // where Submit-for-approval is offered). Drives a red banner + the
  // disabled state of the Submit button.
  const readiness =
    data.run.status === "DRAFT"
      ? await getPayrollRunReadiness({ runId: id })
      : null

  // Smart-hint banner data — only meaningful while the admin can
  // still adjust the run. Once SUBMITTED the figures are frozen and
  // any catch-up adjustment belongs on the next month's run, not this
  // one.
  const salaryChangeHints =
    data.run.status === "SUBMITTED"
      ? []
      : ((await getSalaryChangeHintsForRun({ runId: id })) ?? [])

  const ready = data.employees.filter((e) => e.ready)
  // Detect "the run had payslips but my policy scope hid them all".
  // Owners / legacy admins have `policyIdScope === null` (no filter) —
  // for them an empty SUBMITTED run is genuinely empty. Restricted
  // admins with a non-null scope see a friendlier banner explaining
  // the run isn't empty in absolute terms, just empty for them.
  const policyIdScope = await getActiveAdminPolicyScope()
  const hiddenByPolicyFilter =
    data.run.status === "SUBMITTED" &&
    data.payslips.length === 0 &&
    policyIdScope !== null
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
  const isImported = data.run.source === "IMPORTED"
  const onPayslip = new Set(data.payslips.map((p) => p.employeeProfileId))
  const readyMissingPayslip = ready.filter(
    (e) => !onPayslip.has(e.employeeProfileId),
  )

  // The "needs setup / not yet on a payslip" tables and the payslips
  // list are put behind tabs (Payslips default) when BOTH have content,
  // so the payslips aren't buried under setup cards. When only one has
  // content, it renders on its own with no tab bar.
  // Employees whose net pay was floored to 0 (deductions > pay). Shown
  // in the "Needs attention" section on any run, alongside the draft
  // setup tables.
  const netCapped = data.payslips
    .filter((p) => (p.netShortfall ?? 0) > 0.005)
    .map((p) => ({
      employeeProfileId: p.employeeProfileId,
      name: p.snapshotName,
      employeeId: p.snapshotEmployeeId,
      jobTitle: p.snapshotPosition ?? "",
      netShortfall: p.netShortfall,
    }))
  const hasSetupItems =
    isDraft && (needsSetup.length > 0 || readyMissingPayslip.length > 0)
  const attentionCount =
    (hasSetupItems ? needsSetup.length + readyMissingPayslip.length : 0) +
    netCapped.length
  const setupNode =
    hasSetupItems || netCapped.length > 0 ? (
      <div className="print:hidden">
        <PayrollRunEmployeeTables
          runId={data.run.id}
          hasPayslips={data.payslips.length > 0}
          needsSetup={hasSetupItems ? needsSetup : []}
          readyEmployees={hasSetupItems ? readyMissingPayslip : []}
          netCapped={netCapped}
        />
      </div>
    ) : null
  const payslipsNode =
    data.payslips.length > 0 ? (
      <PayslipsListPanel
        runId={data.run.id}
        payslips={data.payslips}
        showAdjustLink
        runIsDraft={isDraft}
        canEmail={data.run.status === "SUBMITTED"}
      />
    ) : null

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

      {setupNode && payslipsNode ? (
        <PayrollRunContentTabs
          payslips={payslipsNode}
          setup={setupNode}
          payslipCount={data.payslips.length}
          setupCount={attentionCount}
          defaultTab="payslips"
        />
      ) : (
        setupNode
      )}

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

      {salaryChangeHints.length > 0 ? (
        <SalaryChangeHintsCard
          runId={data.run.id}
          hints={salaryChangeHints}
        />
      ) : null}

      {/* Payslips render either inside the tabs above (when there are
          also setup items) or here on their own when there's nothing to
          set up. `setupNode` is null in the latter case, so the tab
          branch above falls through and we show the list directly. */}
      {setupNode ? null : payslipsNode}

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
                    Ready to Pay
                  </Link>{" "}
                  first.
                </p>
              )}
          </CardContent>
        </Card>
      )}

      {/* Expired-leave cash-out panel. Sibling of Reimbursements —
          surfaces every employee whose carry-forward annual leave
          expired and hasn't yet been paid out. Each attach creates a
          `wages_leave_pay` line on the run's PayrollRunAdjustment. */}
      {(data.attachedLeaveCashouts.length > 0 ||
        (isDraft && data.attachableLeaveCashouts.length > 0)) && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4" />
              Expired leave cash-out
            </CardTitle>
            <CardDescription>
              Annual leave carry-forward days that expired without being
              used. Attach to this run to pay the employee for those
              days at <span className="font-mono">monthlySalary ÷ working-days</span>.
              {data.attachedLeaveCashouts.length > 0 && isDraft
                ? " Re-run payroll after attaching to refresh the totals."
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.attachedLeaveCashouts.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Attached to this run
                </div>
                {data.attachedLeaveCashouts.map((c) => (
                  <AttachedCashoutRow
                    key={c.entitlementId}
                    runId={data.run.id}
                    cashout={c}
                    canDetach={isDraft}
                  />
                ))}
              </div>
            )}
            {isDraft && data.attachableLeaveCashouts.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Available to attach
                </div>
                {data.attachableLeaveCashouts.map((c) => (
                  <AttachableCashoutRow
                    key={c.entitlementId}
                    runId={data.run.id}
                    cashout={c}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {ready.length === 0 && data.payslips.length === 0 && (
        <Card
          className={
            hiddenByPolicyFilter
              ? "border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20 print:hidden"
              : "print:hidden"
          }
        >
          <CardHeader>
            <CardDescription
              className={
                hiddenByPolicyFilter
                  ? "text-amber-900 dark:text-amber-200"
                  : undefined
              }
            >
              {hiddenByPolicyFilter ? (
                <>
                  This payroll run has no employees in your assigned
                  policies. Other policies&apos; payslips were excluded
                  by your access scope — ask the owner if you need a
                  broader view.
                </>
              ) : (
                <>
                  No employees ready for payroll. Complete an
                  employee&apos;s payroll profile to include them on
                  the next run.
                </>
              )}
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

      {/* Statutory readiness — block Submit until Company Info + every
          included employee has the fields the document generators
          (PCB TXT, SOCSO+EIS, EPF CSV, CP8D, EA) require. Better here
          than failing later at file generation with a cryptic error. */}
      {isDraft && readiness && !readiness.ok ? (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <ClipboardList className="h-4 w-4" />
              Required fields missing before this run can be submitted
            </CardTitle>
            <CardDescription className="text-destructive/90">
              Fix the items below so payroll documents (PCB / SOCSO+EIS /
              EPF / CP8D / EA) can be generated cleanly. Submit is
              disabled until everything is filled.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {readiness.orgIssues.length > 0 ? (
              <div>
                <p className="font-semibold text-destructive">
                  Company Info ({readiness.orgIssues.length})
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground/90">
                  {readiness.orgIssues.map((i) => (
                    <li key={i.field}>{i.label}</li>
                  ))}
                </ul>
                <Button asChild size="sm" className="mt-2 rounded-xl">
                  <Link href="/admin/payroll/settings">
                    Go to Payroll Settings →
                  </Link>
                </Button>
              </div>
            ) : null}
            {readiness.employeeIssues.length > 0 ? (
              <div>
                <p className="font-semibold text-destructive">
                  Employees ({readiness.employeeIssues.length})
                </p>
                <ul className="mt-1 space-y-0.5 pl-5 text-foreground/90">
                  {readiness.employeeIssues.slice(0, 20).map((e) => (
                    <li key={e.employeeCode} className="list-disc">
                      <span className="font-semibold text-foreground">
                        {e.name}
                      </span>{" "}
                      <span className="text-xs text-muted-foreground">
                        — missing {e.missing.join(", ")}
                      </span>
                    </li>
                  ))}
                  {readiness.employeeIssues.length > 20 ? (
                    <li className="text-xs text-muted-foreground">
                      …and {readiness.employeeIssues.length - 20} more.
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {isDraft && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DeletePayrollRunDraftButton runId={data.run.id} />
          <div className="flex flex-wrap items-center gap-2">
            <ImportPayrollAdjustmentsDialog
              runId={data.run.id}
              periodLabel={periodLabel(
                data.run.periodYear,
                data.run.periodMonth,
              )}
            />
            <GeneratePayslipsButton
              runId={data.run.id}
              hasExisting={data.payslips.length > 0}
            />
            {data.payslips.length > 0 && (
              <SubmitPayrollRunButton
                runId={data.run.id}
                disabled={
                  data.isStale || (readiness != null && !readiness.ok)
                }
                disabledHint={
                  data.isStale
                    ? "Re-run payroll first so the payslips reflect your latest changes."
                    : `Fix ${readiness?.totalMissingCount ?? 0} required field(s) above before submitting.`
                }
              />
            )}
          </div>
        </div>
      )}

      {isImported && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DeleteImportedRunButton runId={data.run.id} />
          <p className="text-xs text-muted-foreground">
            Imported from a YTD migration upload. Deleting removes this
            month&rsquo;s imported payslips only — employee salaries and
            salary history are untouched.
          </p>
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
            {/* Approver workflow: lets the admin who submitted the run
                send the summary PDF to the off-system approver (boss,
                accountant, etc.) for sign-off before clicking Approve
                here. The PDF route at /summary has no status gate of
                its own — it just needs payslips to exist, which a
                PENDING_APPROVAL run always has by the submit-flow
                rule.

                Client-side fetch → blob → anchor.click (instead of a
                plain <a href="?download=1">) so the browser never
                navigates AWAY from this page to the raw stream URL.
                The old anchor version worked on desktop Chrome but
                left the tab sitting on the /summary URL with no UI on
                mobile Safari / in-app webviews — Nicholas reported
                that as "logs me out" (the page appears blank). */}
            <DownloadPayrollSummaryButton
              runId={data.run.id}
              className="rounded-xl"
            />
            <SendBackToDraftButton runId={data.run.id} />
            <ApprovePayrollRunButton
              runId={data.run.id}
              hasXeroConnection={hasXeroConnection}
            />
          </div>
        </div>
      )}

      {isSubmitted && (
        <>
          {data.run.source === "IMPORTED" ? (
            // Imported runs are view-only — Download files / Revert
            // to draft are deliberately hidden. The "one year, one
            // upload" rule means the only way to change an imported
            // run's data is to re-upload the year's XLSX from the
            // Payroll Runs page (which atomically replaces every
            // imported run for that year).
            <div className="flex items-start gap-2 rounded-md border border-violet-300/60 bg-violet-50/40 p-3 text-xs text-violet-900 dark:border-violet-700/40 dark:bg-violet-950/20 dark:text-violet-200">
              <FileText className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <strong>This run was imported from a YTD upload.</strong>{" "}
                Payslip values come from the uploaded XLSX as-typed, not
                from the calc engine. To change any value, re-import the
                whole year from{" "}
                <Link
                  href="/admin/payroll/runs"
                  className="underline underline-offset-2 hover:text-violet-700 dark:hover:text-violet-300"
                >
                  Payroll Runs
                </Link>{" "}
                — the new upload replaces every imported run for the
                year.
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Submitted
                {data.run.submittedAt
                  ? ` on ${new Date(data.run.submittedAt).toLocaleString()}`
                  : ""}
                . Payslips are visible to employees.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {reportsModalData ? (
                  <PayrollDownloadsModal
                    runId={reportsModalData.runId}
                    organizationName={reportsModalData.organizationName}
                    periodLabel={periodLabel(
                      data.run.periodYear,
                      data.run.periodMonth,
                    )}
                    canGenerate={reportsModalData.canGenerate}
                    rows={reportsModalData.rows}
                  />
                ) : null}
                <RevertPayrollRunButton
                  runId={data.run.id}
                  laterMonths={revertCascadeMonths}
                />
              </div>
            </div>
          )}

          {/* Xero sync status. Renders three states:
                • SYNCED → green pill with journal number + sync time
                • ERROR  → red banner with the captured error + retry
                • NOT_SYNCED → grey hint that sync didn't fire (admin
                              disabled it or mapping was missing)
              All three are skipped when:
                • The run has been reverted and never synced (no
                  xeroSyncStatus to show).
                • The org has no Xero connection at all — the panels
                  would be meaningless and the Retry button would call
                  a sync that's guaranteed to fail. Orgs that don't
                  use Xero should see nothing here.
          */}
          {hasXeroConnection && data.run.xeroSyncStatus === "SYNCED" ? (
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

          {hasXeroConnection && data.run.xeroSyncStatus === "ERROR" ? (
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

          {hasXeroConnection &&
          data.run.xeroSyncStatus === "NOT_SYNCED" &&
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

/// Already-attached expired-leave row. Mirrors `AttachedRow` (claim).
function AttachedCashoutRow({
  runId,
  cashout,
  canDetach,
}: {
  runId: string
  cashout: PendingLeaveCashout
  canDetach: boolean
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {cashout.employeeName}
          <span className="ml-2 text-xs text-muted-foreground">
            {cashout.expiredDays} day{cashout.expiredDays === 1 ? "" : "s"}{" "}
            · {cashout.leaveTypeCode} {cashout.year}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {cashout.employeeEmail}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">
          {formatMyr(cashout.attachedAmount ?? cashout.suggestedAmount)}
        </span>
        {canDetach && (
          <DetachLeaveCashoutButton
            runId={runId}
            entitlementId={cashout.entitlementId}
          />
        )}
      </div>
    </div>
  )
}

/// Available expired-leave row. Mirrors `AttachableRow` (claim).
/// The Attach button is disabled when the employee has no monthly
/// salary on their payroll profile — without one, we can't compute
/// the cash-out amount.
function AttachableCashoutRow({
  runId,
  cashout,
}: {
  runId: string
  cashout: PendingLeaveCashout
}) {
  const noSalary =
    cashout.monthlySalary == null || cashout.monthlySalary <= 0
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-primary/5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {cashout.employeeName}
          <span className="ml-2 text-xs text-muted-foreground">
            {cashout.expiredDays} day{cashout.expiredDays === 1 ? "" : "s"}{" "}
            · {cashout.leaveTypeCode} {cashout.year}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {cashout.employeeEmail}
          {noSalary ? " · no monthly salary set" : ""}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">
          {formatMyr(cashout.suggestedAmount)}
        </span>
        <AttachLeaveCashoutButton
          runId={runId}
          entitlementId={cashout.entitlementId}
          disabled={noSalary}
          disabledReason="Set the employee's monthly salary on their payroll profile first."
        />
      </div>
    </div>
  )
}
