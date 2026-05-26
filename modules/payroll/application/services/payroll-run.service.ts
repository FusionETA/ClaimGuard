import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getOrSetCache } from "@/lib/cache"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import {
  attendancePercentOf,
  autoHoursFromMinutes,
  calcPayslip,
  workingDaysForPeriod,
} from "@/modules/payroll/domain/calc"
import { PAYROLL_RUN_STATUS_LABELS, periodLabel } from "@/modules/payroll/domain/runs"
import type {
  FixedAllowance,
  PayrollEmployeeRow,
  SalaryType,
} from "@/modules/payroll/domain/models"
import type {
  AttachableClaimRow,
  PayrollRunAdjustmentData,
  PayrollRunClaimRow,
  PayrollRunData,
  PayrollRunRow,
  PayslipData,
  PayslipRow,
} from "@/modules/payroll/domain/runs"
import { employeeLoanRepository } from "@/modules/payroll/infrastructure/employee-loan.repository"
import {
  formatLoanPeriodLabel,
  loanInstallmentForPeriod,
} from "@/modules/payroll/domain/loans"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payrollRunAdjustmentRepository } from "@/modules/payroll/infrastructure/payroll-run-adjustment.repository"
import { payrollRunClaimRepository } from "@/modules/payroll/infrastructure/payroll-run-claim.repository"
import { payrollAnnualReportRepository } from "@/modules/payroll/infrastructure/payroll-annual-report.repository"
import { payrollRunReportRepository } from "@/modules/payroll/infrastructure/payroll-run-report.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  payslipRepository,
  type CreatePayslipInput,
} from "@/modules/payroll/infrastructure/payslip.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { unpaidLeaveDays } from "@/modules/leave/application/services/leave-balance.service"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import { deriveDailyHours } from "@/modules/payroll/domain/calc"

/**
 * Auto "Unpaid Leave" deduction for MONTHLY staff: the base salary is left
 * intact and unpaid leave is docked as a separate `deduct_unpaid_leave`
 * line (daily rate × unpaid days, daily rate = monthlySalary ÷ working-days
 * basis). Returns 0 when not applicable (HOURLY, no unpaid leave, no salary).
 */
function unpaidLeaveDeductionAmount(input: {
  salaryType: "MONTHLY" | "HOURLY"
  monthlySalary: number | null
  unpaidDays: number
  workingDaysBasis: number
}): number {
  if (input.salaryType !== "MONTHLY") return 0
  if (input.monthlySalary == null || input.monthlySalary <= 0) return 0
  if (input.unpaidDays <= 0 || input.workingDaysBasis <= 0) return 0
  const daily = input.monthlySalary / input.workingDaysBasis
  return Math.round(daily * input.unpaidDays * 100) / 100
}

/**
 * Page-data + action services for the "Payroll → Runs" surface.
 *
 * Same guard pattern as the rest of the payroll module: admin-only,
 * scoped to the active org via `resolveActiveOrgId(session)`.
 *
 * Phase 3 scope is the run SHELL only — create draft, list, view
 * eligible employees, delete draft. Payslip generation + submit land
 * in Phase 4 alongside the calculation engine.
 */

// ─── Page data ───────────────────────────────────────────────────────────

export async function getPayrollRunsPageData(): Promise<{
  organizationName: string
  runs: PayrollRunRow[]
  eligibleEmployeeCount: number
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 1-hour TTL — runs list + eligible-employee count rarely change
  // between admin visits, and every payroll mutation busts the
  // `org:<orgId>:payroll:*` namespace via `bustPayrollCaches`. The TTL
  // is just a backstop when a bust is missed.
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "runs-list"),
    3600,
    () => loadPayrollRunsPageData(orgId),
  )
}

async function loadPayrollRunsPageData(orgId: string): Promise<{
  organizationName: string
  runs: PayrollRunRow[]
  eligibleEmployeeCount: number
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, runs, employees] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.listForOrganization(orgId),
    payrollProfileRepository.listForOrganization(orgId),
  ])

  return {
    organizationName: org?.name ?? "",
    runs,
    eligibleEmployeeCount: employees.filter(isReadyForPayroll).length,
  }
}

export async function getPayrollRunDetailPageData(input: {
  runId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  /// Every employee in the org with a PayrollProfile, with a flag for
  /// whether they're "ready" (complete + not archived). Used by the
  /// run detail page to preview who will be on the payslip generator.
  employees: Array<PayrollEmployeeRow & { ready: boolean }>
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, run, employees] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.getByIdForOrg({
      id: input.runId,
      organizationId: orgId,
    }),
    payrollProfileRepository.listForOrganization(orgId),
  ])

  if (!run) return null

  return {
    organizationName: org?.name ?? "",
    run,
    employees: employees.map((e) => ({
      ...e,
      ready: isReadyForPayroll(e),
    })),
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────

export async function createPayrollRunDraft(input: {
  periodYear: number
  periodMonth: number
}): Promise<PayrollRunData> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Short-circuit if a run already exists for this period — gives a
  // friendlier error than the DB unique-constraint violation.
  const existing = await payrollRunRepository.findByPeriod({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
  })
  if (existing) {
    throw new Error(
      "A payroll run already exists for this period. Open it instead of creating a new one.",
    )
  }

  const nextSubmitted = await payrollRunRepository.findNextSubmittedAfterPeriod({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
  })
  if (nextSubmitted) {
    throw new Error(
      `Cannot create a draft for ${periodLabel(input.periodYear, input.periodMonth)} because ${periodLabel(nextSubmitted.periodYear, nextSubmitted.periodMonth)} has already been submitted. Revert the later run to draft first if you need to backfill an earlier period.`,
    )
  }

  const draft = await payrollRunRepository.createDraft({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
  })
  await bustPayrollCaches({ organizationId: orgId })
  return draft
}

/**
 * Submit a draft run. Locks the run as immutable — claim attachments
 * can no longer be added/removed, payslips can no longer be
 * regenerated. Captures `submittedAt` + `submittedById` for audit.
 *
 * Pre-conditions: run is DRAFT and has at least one payslip on file
 * (we don't want to submit an empty run).
 */
/**
 * Step 1 of the two-step approval flow. Locks the run from further
 * edits and parks it in PENDING_APPROVAL so an admin (any admin —
 * including the submitter themselves, per org policy) can give it a
 * final review. Pre-conditions: DRAFT with at least one payslip.
 */
export async function submitPayrollRunForApproval(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error("This run has already been submitted for approval.")
  }
  if (run.payslipCount === 0) {
    throw new Error(
      "Run payroll before submitting for approval — an empty run can't be finalised.",
    )
  }

  const payslips = await payslipRepository.listForRun(run.id)

  // Guard 1 — stale draft. Inputs changed (e.g. a loan was created /
  // edited / cancelled) after the last Generate, so the payslips no
  // longer reflect reality. `lastMutatedAt` is bumped on every such
  // change and cleared on Generate; if it's newer than the most-recent
  // payslip, force a re-run before submission.
  if (run.lastMutatedAt != null && payslips.length > 0) {
    const latestGeneration = payslips
      .map((p) => p.createdAt)
      .reduce((acc, v) => (v > acc ? v : acc), payslips[0]!.createdAt)
    if (run.lastMutatedAt > latestGeneration) {
      throw new Error(
        "Payroll inputs changed since this draft was generated (e.g. a loan was updated). Re-run payroll before submitting.",
      )
    }
  }

  // Guard 2 — no employee may have zero or negative net pay (e.g. a
  // loan installment / deductions larger than their take-home). Block
  // and name the affected employees.
  const nonPositive = payslips.filter((p) => p.netPay <= 0)
  if (nonPositive.length > 0) {
    const names = nonPositive
      .slice(0, 5)
      .map((p) => p.snapshotName)
      .join(", ")
    const more =
      nonPositive.length > 5 ? ` and ${nonPositive.length - 5} more` : ""
    throw new Error(
      `Cannot submit — net pay is zero or negative for: ${names}${more}. Reduce their deductions or loan installment, then re-run payroll.`,
    )
  }

  // Guard 3 — chronological order. A month can't be submitted while
  // the immediately-preceding month's run is still sitting unsubmitted
  // (DRAFT / PENDING_APPROVAL). This stops admins skipping ahead and
  // leaving an earlier month un-finalised. We only block when a prior
  // run actually EXISTS but isn't SUBMITTED yet — if there's simply no
  // run for the previous month (e.g. the org's first run, or a month
  // genuinely skipped), submission is allowed.
  const prevPeriod =
    run.periodMonth > 1
      ? { year: run.periodYear, month: run.periodMonth - 1 }
      : { year: run.periodYear - 1, month: 12 }
  const previousRun = await payrollRunRepository.findByPeriod({
    organizationId: orgId,
    periodYear: prevPeriod.year,
    periodMonth: prevPeriod.month,
  })
  if (previousRun && previousRun.status !== "SUBMITTED") {
    throw new Error(
      `Submit ${periodLabel(prevPeriod.year, prevPeriod.month)} first — payroll runs must be submitted in order, and that month's run is still ${PAYROLL_RUN_STATUS_LABELS[previousRun.status].toLowerCase()}.`,
    )
  }

  await payrollRunRepository.submitForApproval({
    id: run.id,
    organizationId: orgId,
    submittedById: session.userId,
  })
  await bustPayrollCaches({ organizationId: orgId })
}

/**
 * Step 2 of the two-step approval flow. Approver flips
 * PENDING_APPROVAL → SUBMITTED. Records the approver as the
 * `submittedBy` user so the eventual audit trail names the person
 * who really put this run live, not just the person who proposed it.
 *
 * Optionally fires the Xero manual journal post (when the org has
 * `syncPayrollToXeroOnSubmit` enabled and a complete `xeroMapping`).
 * Xero sync failures DO NOT block approval — the run flips to
 * SUBMITTED regardless. Sync errors are persisted on the run for the
 * UI to surface + offer a retry.
 *
 * Returns the Xero sync outcome so the caller can show a panel:
 *   - `synced`  → "Approved. Posted to Xero as journal #X."
 *   - `skipped` → "Approved. Xero sync skipped: <reason>."
 *   - `error`   → "Approved. Xero sync failed: <message>. [Retry]"
 *   - undefined → admin disabled Xero sync; run approved silently.
 */
export async function approvePayrollRun(input: {
  runId: string
}): Promise<{
  xeroSync?:
    | { status: "synced"; manualJournalId: string; narration: string }
    | { status: "skipped"; message: string }
    | { status: "error"; message: string }
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "PENDING_APPROVAL") {
    throw new Error("Only runs awaiting approval can be approved.")
  }

  await payrollRunRepository.approve({
    id: run.id,
    organizationId: orgId,
    approvedById: session.userId,
  })
  // Bust early — Xero sync below also mutates the run (xeroSyncStatus),
  // and any errors there bust again. The early bust guarantees the
  // status flip is visible even if sync hangs or the request aborts.
  await bustPayrollCaches({ organizationId: orgId })
  // Approving this run added a new month into the year's annual
  // aggregates — clear cached annual reports so the next generate
  // includes this period.
  await payrollAnnualReportRepository.deleteForYear({
    organizationId: orgId,
    year: run.periodYear,
  })

  // Best-effort Xero sync. Lazy-imported to keep the payroll-run
  // service light when Xero isn't configured.
  const settings = await payrollSettingsRepository.getByOrgId(orgId)
  const result: Awaited<ReturnType<typeof approvePayrollRun>> = {}

  // NOTE: Claims attached to this run are NO LONGER posted as separate
  // Xero bills here. They're reimbursements paid out *through* payroll,
  // so they ride along in the payroll manual journal below (as
  // REIMBURSEMENT debit lines + a reimbursement-inclusive net-payable
  // credit). Posting them as bills too would double-count the payable.
  //
  // Claims that should hit Xero as a standalone awaiting-payment bill
  // (personal) or Spend Money (company) are synced directly from the
  // "Ready to Pay" tab instead, not via payroll attachment.

  if (settings?.syncPayrollToXeroOnSubmit) {
    try {
      const { syncPayrollRunToXero } = await import(
        "@/modules/payroll/application/services/xero-payroll-sync.service"
      )
      result.xeroSync = await syncPayrollRunToXero(run.id)
    } catch (err) {
      console.error("[payroll-run] post-approval Xero sync threw:", err)
      result.xeroSync = {
        status: "error",
        message: "Xero sync failed unexpectedly. Use the retry button.",
      }
    }
  }

  return result
}

/**
 * Approver bounces a PENDING_APPROVAL run back to DRAFT. Captures
 * an optional reason for the submitter; submitter can then edit
 * and re-submit.
 */
export async function rejectPayrollRunApproval(input: {
  runId: string
  reason: string | null
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  await payrollRunRepository.rejectApproval({
    id: input.runId,
    organizationId: orgId,
    reason: input.reason?.trim() || null,
  })
  await bustPayrollCaches({ organizationId: orgId })
}

/**
 * Reverse a submitted run back to DRAFT. Existing payslips + claim
 * attachments stay attached — admin can edit and re-submit. Used when
 * payroll data was wrong and the run needs adjusting after submit.
 */
export async function revertPayrollRunToDraft(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Fetch the run first so we know which year's annual reports to bust.
  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")

  // Cascade: later SUBMITTED months in the same year carry YTD-
  // cumulative figures (PCB, SOCSO+EIS relief) that depend on this
  // month. Reverting this month invalidates them, so they must revert
  // to draft too. The admin is warned about this in the confirm modal
  // (see getLaterSubmittedRunsForRevert / RevertPayrollRunButton).
  const laterRuns = await payrollRunRepository.listSubmittedLaterInYear({
    organizationId: orgId,
    periodYear: run.periodYear,
    afterMonth: run.periodMonth,
  })

  // Revert the target run plus every later submitted month.
  const runIdsToRevert = [input.runId, ...laterRuns.map((r) => r.id)]
  for (const id of runIdsToRevert) {
    await payrollRunRepository.revertToDraft({ id, organizationId: orgId })
    // Clear cached generated reports for each reverted run — their
    // numbers may become stale once the admin edits the draft, so we
    // force a re-generation on the next submit.
    await payrollRunReportRepository.deleteForRun(id)
  }

  // Annual reports for this run's year are invalidated — these runs are
  // no longer SUBMITTED so their contribution shouldn't be included.
  await payrollAnnualReportRepository.deleteForYear({
    organizationId: orgId,
    year: run.periodYear,
  })
  await bustPayrollCaches({ organizationId: orgId })
}

/**
 * List the later SUBMITTED months in the same year that a revert of
 * `runId` would ALSO cascade back to draft. The run-detail page passes
 * these labels to the revert confirm modal so the admin sees exactly
 * which other months will be affected before confirming. Returns an
 * empty array when there's nothing downstream (the common case).
 */
export async function getLaterSubmittedRunsForRevert(input: {
  runId: string
}): Promise<string[]> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return []
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return []

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run || run.status !== "SUBMITTED") return []

  const laterRuns = await payrollRunRepository.listSubmittedLaterInYear({
    organizationId: orgId,
    periodYear: run.periodYear,
    afterMonth: run.periodMonth,
  })
  return laterRuns.map((r) => periodLabel(r.periodYear, r.periodMonth))
}

export async function deletePayrollRunDraft(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  await payrollRunRepository.deleteDraft({
    id: input.runId,
    organizationId: orgId,
  })
  await bustPayrollCaches({ organizationId: orgId })
}

/**
 * Generate payslips for every ready employee on a draft run.
 *
 * Order:
 *   1. Verify the run exists in this org and is still DRAFT.
 *   2. Load org PayrollSettings (fall back to schema defaults).
 *   3. Pull all employees with complete + non-archived payroll profiles.
 *   4. Run `calcPayslip` per employee.
 *   5. Atomically delete existing payslips + write the fresh batch.
 *   6. Refresh the run's cached totals.
 *
 * Returns the number of payslips generated. Safe to call repeatedly —
 * each call recomputes from scratch, so payroll settings or profile
 * changes show up on the next "Generate" press.
 */
/**
 * Recompute a SINGLE employee's net pay for a draft run using a
 * proposed (not-yet-saved) adjustment. Powers the deduction modal's
 * "net pay can't go below zero" guard — the same `calcPayslip` engine
 * the real generation uses, so statutory recompute on allowance/OT/
 * deduction changes is exact. Also folds in the employee's active loan
 * installment for the period, so the guard reflects what will actually
 * be deducted.
 *
 * Returns null when the caller isn't authorised or the run/employee
 * can't be resolved (the modal then skips client-side blocking and
 * relies on the save succeeding).
 */
export async function previewEmployeeNetForRun(input: {
  runId: string
  employeeProfileId: string
  patch: {
    otNormalHours: number
    otRestHours: number
    otPublicHours: number
    workedHours?: number | null
    expectedHours?: number | null
    manualLineItems: { kind: string; category: string; label: string; amount: number }[]
    fixedAllowanceOverrides: Record<
      string,
      { amount: number | null; skip: boolean }
    >
  }
}): Promise<{ netPay: number; grossPay: number } | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  const [settings, employees, policies, attachments, activeLoans, orgHours] =
    await Promise.all([
      payrollSettingsRepository.getByOrgId(orgId),
      payrollProfileRepository.listReadyForPayroll(orgId),
      policyRepository.listForOrganization(orgId),
      payrollRunClaimRepository.listForCalc(run.id),
      employeeLoanRepository.listActiveForOrganization(orgId),
      (async () => {
        const prisma = getPrismaClient()
        if (!prisma) return { workingHoursStart: "09:00", workingHoursEnd: "18:00" }
        const org = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { workingHoursStart: true, workingHoursEnd: true },
        })
        return {
          workingHoursStart: org?.workingHoursStart ?? "09:00",
          workingHoursEnd: org?.workingHoursEnd ?? "18:00",
        }
      })(),
    ])

  const e = employees.find((x) => x.employeeProfileId === input.employeeProfileId)
  if (!e) return null

  // Apply the proposed fixed-allowance overrides.
  const overrides = input.patch.fixedAllowanceOverrides ?? {}
  const overriddenFixed: typeof e.profile.fixedAllowances = []
  e.profile.fixedAllowances.forEach((a, i) => {
    const override = overrides[String(i)]
    if (!override) {
      overriddenFixed.push(a)
      return
    }
    if (override.skip) return
    if (override.amount != null) {
      overriddenFixed.push({ ...a, amount: override.amount })
      return
    }
    overriddenFixed.push(a)
  })

  const oneOffLines = (input.patch.manualLineItems ?? []).map((li) => ({
    category: li.category as (typeof overriddenFixed)[number]["category"],
    name: li.label,
    amount: li.amount,
  }))

  // Fold in the active loan installment(s) for this period so the guard
  // reflects the loan deduction the run will actually apply.
  for (const loan of activeLoans.filter(
    (l) => l.employeeProfileId === e.employeeProfileId,
  )) {
    const installment = loanInstallmentForPeriod(
      loan,
      run.periodYear,
      run.periodMonth,
    )
    if (installment > 0) {
      oneOffLines.push({
        category: "deduct_advance" as (typeof overriddenFixed)[number]["category"],
        name: "Loan repayment",
        amount: installment,
      })
    }
  }

  // Mirror the run's auto "Unpaid Leave" deduction (MONTHLY) so the
  // net-pay guard matches what generation will produce.
  const previewFrom = new Date(Date.UTC(run.periodYear, run.periodMonth - 1, 1))
  const previewTo = new Date(
    Date.UTC(run.periodYear, run.periodMonth, 0, 23, 59, 59),
  )
  const previewUnpaidDeduct = unpaidLeaveDeductionAmount({
    salaryType: e.profile.salaryType,
    monthlySalary: e.profile.monthlySalary,
    unpaidDays: await unpaidLeaveDays(e.employeeProfileId, previewFrom, previewTo),
    workingDaysBasis: workingDaysForPeriod({
      year: run.periodYear,
      month: run.periodMonth,
      rule: settings?.workingDaysRule ?? "TWENTY_SIX",
    }),
  })
  if (previewUnpaidDeduct > 0) {
    oneOffLines.push({
      category: "deduct_unpaid_leave" as (typeof overriddenFixed)[number]["category"],
      name: "Unpaid Leave",
      amount: previewUnpaidDeduct,
    })
  }

  const ytdRaw = await payslipRepository.getYtdForEmployee({
    employeeProfileId: e.employeeProfileId,
    year: run.periodYear,
    excludeRunId: run.id,
  })
  const joinedThisYear =
    e.profile.joinDate &&
    new Date(e.profile.joinDate).getUTCFullYear() === run.periodYear
  const isPrevForSameYear =
    joinedThisYear && (e.profile.prevEmploymentYear ?? null) === run.periodYear
  const ytd = {
    ytdTaxable:
      ytdRaw.ytdTaxable + (isPrevForSameYear ? e.profile.prevRemuneration ?? 0 : 0),
    ytdEpf: ytdRaw.ytdEpf + (isPrevForSameYear ? e.profile.prevEpf ?? 0 : 0),
    ytdPcb: ytdRaw.ytdPcb + (isPrevForSameYear ? e.profile.prevPcb ?? 0 : 0),
    ytdZakat: ytdRaw.ytdZakat + (isPrevForSameYear ? e.profile.prevZakat ?? 0 : 0),
    ytdSocsoEis: ytdRaw.ytdSocsoEis,
    ytdAllowanceByCategory: ytdRaw.ytdAllowanceByCategory,
  }

  const policy = e.policyId ? policies.find((p) => p.id === e.policyId) ?? null : null
  const cashOt = policy !== null && policy.otEnabled && policy.otMethod === "CASH"
  const calcSettings = {
    workingDaysRule: settings?.workingDaysRule ?? "TWENTY_SIX",
    defaultEpfEmployeeRate: settings?.defaultEpfEmployeeRate ?? 11,
    defaultEpfEmployerRate: settings?.defaultEpfEmployerRate ?? 13,
    hrdfEnabled: settings?.hrdfEnabled ?? false,
    hrdfRate: settings?.hrdfRate ?? null,
    autoApplySocsoEisRelief: settings?.autoApplySocsoEisRelief ?? true,
    otRateNormal: cashOt ? policy!.otRateNormalDay : 0,
    otRateRest: cashOt ? policy!.otRateRestDay : 0,
    otRatePublicHoliday: cashOt ? policy!.otRatePublicHoliday : 0,
  } as const

  const reimbursements = attachments
    .filter((a) => a.employeeProfileId === e.employeeProfileId)
    .map((a) => ({ id: a.claimId, label: a.label, amount: a.amount }))

  // HOURLY gross = worked hours × rate. Use the admin's override if set,
  // else the attendance-derived hours (when the policy grants attendance).
  let previewWorkedHours = input.patch.workedHours ?? null
  if (previewWorkedHours == null && policy?.canAccessAttendance === true) {
    const hoursMap = await attendanceRepository.getPayrollHoursForProfiles({
      organizationId: orgId,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      employees: [
        {
          employeeProfileId: e.employeeProfileId,
          joinDate: e.profile.joinDate,
          leaveDate: e.profile.leaveDate,
        },
      ],
    })
    const hrs = hoursMap.get(e.employeeProfileId) ?? null
    previewWorkedHours = autoHoursFromMinutes({
      salaryType: e.profile.salaryType,
      workedMin: hrs?.workedMin ?? 0,
      scheduledMin: hrs?.scheduledMin ?? 0,
      paidLeaveMin: hrs?.paidLeaveMin ?? 0,
    }).workedHours
  }

  const result = calcPayslip({
    profile: { ...e.profile, fixedAllowances: [...overriddenFixed, ...oneOffLines] },
    settings: calcSettings,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    dailyHours: deriveDailyHours({ project: e.primaryProject, org: orgHours }),
    otNormalHours: input.patch.otNormalHours,
    otRestHours: input.patch.otRestHours,
    otPublicHours: input.patch.otPublicHours,
    workedHours: previewWorkedHours,
    workingDaySet: parseWorkingDays(e.primaryProject?.workingDays ?? null),
    reimbursements,
    manualDeductions: [],
    ytdTaxable: ytd.ytdTaxable,
    ytdEpf: ytd.ytdEpf,
    ytdPcb: ytd.ytdPcb,
    ytdZakat: ytd.ytdZakat,
    ytdSocsoEis: ytd.ytdSocsoEis,
    ytdAllowanceByCategory: ytd.ytdAllowanceByCategory,
  })

  return { netPay: result.netPay, grossPay: result.grossPay }
}

export async function generatePayrollPayslips(input: {
  runId: string
}): Promise<{ count: number }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error("Only draft runs can be run again.")
  }

  const [settings, employees, attachments, adjustments, policies, orgHours, activeLoans] =
    await Promise.all([
      payrollSettingsRepository.getByOrgId(orgId),
      payrollProfileRepository.listReadyForPayroll(orgId),
      payrollRunClaimRepository.listForCalc(run.id),
      payrollRunAdjustmentRepository.listForRun(run.id),
      policyRepository.listForOrganization(orgId),
      (async () => {
        const prisma = getPrismaClient()
        if (!prisma) return { workingHoursStart: "09:00", workingHoursEnd: "18:00" }
        const org = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { workingHoursStart: true, workingHoursEnd: true },
        })
        return {
          workingHoursStart: org?.workingHoursStart ?? "09:00",
          workingHoursEnd: org?.workingHoursEnd ?? "18:00",
        }
      })(),
      employeeLoanRepository.listActiveForOrganization(orgId),
    ])

  // Active loans grouped by employee — each contributes a
  // `deduct_advance` (Advance Deduction) installment for this run's
  // period (0 when outside the repayment window, so finished loans
  // drop off).
  const loansByEmp = new Map<string, typeof activeLoans>()
  for (const loan of activeLoans) {
    const list = loansByEmp.get(loan.employeeProfileId) ?? []
    list.push(loan)
    loansByEmp.set(loan.employeeProfileId, list)
  }
  const policyById = new Map(policies.map((p) => [p.id, p]))

  if (employees.length === 0) {
    throw new Error(
      "No employees are ready for payroll. Complete at least one employee's payroll profile and try again.",
    )
  }

  // Group reimbursement attachments by employee for fast per-loop
  // lookup. Each attachment row maps to one REIMBURSEMENT line item.
  const reimbursementsByEmp = new Map<
    string,
    Array<{ id: string; label: string; amount: number }>
  >()
  for (const a of attachments) {
    const list = reimbursementsByEmp.get(a.employeeProfileId) ?? []
    list.push({ id: a.claimId, label: a.label, amount: a.amount })
    reimbursementsByEmp.set(a.employeeProfileId, list)
  }

  // Org-wide payroll settings shared by every employee. Per-employee OT
  // multipliers come from each employee's assigned policy below — they
  // are no longer org-wide.
  const baseCalcSettings = {
    workingDaysRule: settings?.workingDaysRule ?? "TWENTY_SIX",
    defaultEpfEmployeeRate: settings?.defaultEpfEmployeeRate ?? 11,
    defaultEpfEmployerRate: settings?.defaultEpfEmployerRate ?? 13,
    hrdfEnabled: settings?.hrdfEnabled ?? false,
    hrdfRate: settings?.hrdfRate ?? null,
    // Default ON when the row is missing (new orgs) so admins get
    // the HReasily-style monthly PCB out of the box. Turn off if
    // strict LHDN-TP1 reading is preferred.
    autoApplySocsoEisRelief: settings?.autoApplySocsoEisRelief ?? true,
  } as const

  function calcSettingsForEmployee(policyId: string | null): {
    otRateNormal: number
    otRateRest: number
    otRatePublicHoliday: number
    workingDaysRule: typeof baseCalcSettings.workingDaysRule
    defaultEpfEmployeeRate: number
    defaultEpfEmployerRate: number
    hrdfEnabled: boolean
    hrdfRate: number | null
  } {
    const policy = policyId ? policyById.get(policyId) ?? null : null
    // OT rates only apply when the policy is in CASH mode. For
    // TIME_BANK, NO-OT, or unassigned policy, zero out the multipliers
    // so any leaked OT hours produce zero cash pay.
    const cashOt =
      policy !== null && policy.otEnabled && policy.otMethod === "CASH"
    return {
      ...baseCalcSettings,
      otRateNormal: cashOt ? policy!.otRateNormalDay : 0,
      otRateRest: cashOt ? policy!.otRateRestDay : 0,
      otRatePublicHoliday: cashOt ? policy!.otRatePublicHoliday : 0,
    }
  }

  // Fetch YTD per-employee in parallel (needed for the PCB calc).
  // Excludes this current draft so the figure represents what's
  // already finalised. Prev-employer carryover gets folded in below.
  const ytdEntries = await Promise.all(
    employees.map(async (e) => {
      const ytd = await payslipRepository.getYtdForEmployee({
        employeeProfileId: e.employeeProfileId,
        year: run.periodYear,
        excludeRunId: run.id,
      })
      // Add prev-employer TP3-like carryover when the employee joined
      // this year (prev income from a different employer in the same
      // calendar year — pulled from the payroll profile).
      const joinedThisYear =
        e.profile.joinDate &&
        new Date(e.profile.joinDate).getUTCFullYear() === run.periodYear
      const isPrevForSameYear =
        joinedThisYear && (e.profile.prevEmploymentYear ?? null) === run.periodYear
      return {
        empId: e.employeeProfileId,
        // TP3 carryover: add the prev-employer figures to each YTD
        // bucket only when the employee's `prevEmploymentYear` equals
        // the current run's calendar year. Per LHDN MTD Spec § 10
        // (page 23) the TP3 form provides (Y-K), X, Z, ΣLP.
        ytdTaxable:
          ytd.ytdTaxable + (isPrevForSameYear ? e.profile.prevRemuneration ?? 0 : 0),
        ytdEpf: ytd.ytdEpf + (isPrevForSameYear ? e.profile.prevEpf ?? 0 : 0),
        ytdPcb: ytd.ytdPcb + (isPrevForSameYear ? e.profile.prevPcb ?? 0 : 0),
        ytdZakat:
          ytd.ytdZakat + (isPrevForSameYear ? e.profile.prevZakat ?? 0 : 0),
        // Prev-employer SOCSO+EIS carryover is intentionally omitted —
        // the RM 350 cap saturates at typical contribution levels
        // within the first ~3-4 months, so a mid-year joiner converges
        // to the same answer with or without the prior-employer
        // figure. (We could add a `prevSocsoEis` profile field later
        // if needed for early-year joiners, but the PCB delta is
        // typically < RM 5 / month.)
        ytdSocsoEis: ytd.ytdSocsoEis,
        ytdAllowanceByCategory: ytd.ytdAllowanceByCategory,
      }
    }),
  )
  const ytdByEmp = new Map(ytdEntries.map((y) => [y.empId, y]))

  // Worked / scheduled / paid-leave minutes per employee, used to default
  // the regular working-hours figures (the HRS column). MONTHLY staff get
  // a leave-adjusted percentage; HOURLY staff get absolute paid hours.
  const hoursByEmp = await attendanceRepository.getPayrollHoursForProfiles({
    organizationId: orgId,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    employees: employees.map((e) => ({
      employeeProfileId: e.employeeProfileId,
      joinDate: e.profile.joinDate,
      leaveDate: e.profile.leaveDate,
    })),
  })

  // Approved UNPAID leave days per employee for the period — display-only
  // snapshot for the DAYS column (actual working days = company working
  // days − unpaid leave). Does not affect pay.
  const periodFrom = new Date(Date.UTC(run.periodYear, run.periodMonth - 1, 1))
  const periodTo = new Date(
    Date.UTC(run.periodYear, run.periodMonth, 0, 23, 59, 59),
  )
  const unpaidLeaveByEmp = new Map(
    await Promise.all(
      employees.map(
        async (e) =>
          [
            e.employeeProfileId,
            await unpaidLeaveDays(e.employeeProfileId, periodFrom, periodTo),
          ] as const,
      ),
    ),
  )

  const payslips: CreatePayslipInput[] = employees.map((e) => {
    const adj = adjustments.get(e.employeeProfileId) ?? null
    const ytd = ytdByEmp.get(e.employeeProfileId)
    // Apply per-run overrides to the profile's fixed adjustments:
    // - `skip: true` → drop the row for this run
    // - `amount: number` → replace amount but preserve `category` so
    //   the EPF/SOCSO/EIS/PCB subject-to flags follow through
    // - missing index → use the profile default
    const overrides = adj?.fixedAllowanceOverrides ?? {}
    const overriddenFixed: typeof e.profile.fixedAllowances = []
    e.profile.fixedAllowances.forEach((a, i) => {
      const override = overrides[String(i)]
      if (!override) {
        overriddenFixed.push(a)
        return
      }
      if (override.skip) return
      if (override.amount != null) {
        overriddenFixed.push({ ...a, amount: override.amount })
        return
      }
      overriddenFixed.push(a)
    })

    // Merge one-off line items (allowances + deductions) into the
    // profile snapshot. The calc engine's fixedAllowances loop
    // dispatches on `meta.kind` (ALLOWANCE / DEDUCTION /
    // REIMBURSEMENT) and applies statutory flags via the category
    // meta — so DEDUCTIONs land in the right bucket and respect
    // `reducesBase` / EPF / SOCSO / EIS / PCB. Pre-Phase-19 line
    // items without `category` get safe defaults from the repo
    // parser, so legacy data still works.
    const oneOffLines = (adj?.manualLineItems ?? []).map((li) => ({
      category: li.category as (typeof overriddenFixed)[number]["category"],
      name: li.label,
      amount: li.amount,
    }))

    // Auto-applied loan installments for this period. A loan repayment
    // is recorded under the existing "Advance Deduction" category
    // (`deduct_advance`), added as a one-off line so it flows through
    // the same category-aware calc + Xero deduction credit.
    for (const loan of loansByEmp.get(e.employeeProfileId) ?? []) {
      const installment = loanInstallmentForPeriod(
        loan,
        run.periodYear,
        run.periodMonth,
      )
      if (installment > 0) {
        oneOffLines.push({
          category: "deduct_advance" as (typeof overriddenFixed)[number]["category"],
          name: `Loan repayment (${formatLoanPeriodLabel(
            loan.startYear,
            loan.startMonth,
          )} start)`,
          amount: installment,
        })
      }
    }

    // Auto "Unpaid Leave" deduction (MONTHLY): the base salary stays full;
    // approved unpaid leave is docked as its own line so the payslip reads
    // "Base salary 3000 / Unpaid Leave −115.38". Flows through the
    // category-aware calc, reducing gross/net + EPF/SOCSO/EIS/PCB/HRDF.
    const unpaidLeaveDeduct = unpaidLeaveDeductionAmount({
      salaryType: e.profile.salaryType,
      monthlySalary: e.profile.monthlySalary,
      unpaidDays: unpaidLeaveByEmp.get(e.employeeProfileId) ?? 0,
      workingDaysBasis: workingDaysForPeriod({
        year: run.periodYear,
        month: run.periodMonth,
        rule: settings?.workingDaysRule ?? "TWENTY_SIX",
      }),
    })
    if (unpaidLeaveDeduct > 0) {
      oneOffLines.push({
        category: "deduct_unpaid_leave" as (typeof overriddenFixed)[number]["category"],
        name: "Unpaid Leave",
        amount: unpaidLeaveDeduct,
      })
    }

    const profileWithAdjAllowances = {
      ...e.profile,
      fixedAllowances: [...overriddenFixed, ...oneOffLines],
    }

    const calcSettings = calcSettingsForEmployee(e.policyId)
    const dailyHours = deriveDailyHours({
      project: e.primaryProject,
      org: orgHours,
    })

    // Regular working hours (the HRS column) — DISPLAY ONLY. These are
    // snapshotted onto the payslip so the table/payslip can show worked
    // vs expected hours, but they do NOT affect pay: `calcPayslip`
    // prorates by working days, not attendance. Only computed when the
    // employee's policy grants attendance access; otherwise the column
    // shows "—". The admin's per-run override (if any) wins for display.
    const isMonthly = e.profile.salaryType === "MONTHLY"
    const attendanceApplies =
      (e.policyId ? policyById.get(e.policyId)?.canAccessAttendance : undefined) ===
      true
    const hrs = hoursByEmp.get(e.employeeProfileId) ?? null
    const auto = attendanceApplies
      ? autoHoursFromMinutes({
          salaryType: e.profile.salaryType,
          workedMin: hrs?.workedMin ?? 0,
          scheduledMin: hrs?.scheduledMin ?? 0,
          paidLeaveMin: hrs?.paidLeaveMin ?? 0,
        })
      : { workedHours: null, expectedHours: null }
    const displayWorkedHours = adj?.workedHours ?? auto.workedHours
    const displayExpectedHours = isMonthly
      ? adj?.expectedHours ?? auto.expectedHours
      : null

    const result = calcPayslip({
      profile: profileWithAdjAllowances,
      settings: calcSettings,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      dailyHours,
      // OT hours: from the admin's per-employee adjustment row.
      otNormalHours: adj?.otNormalHours ?? 0,
      otRestHours: adj?.otRestHours ?? 0,
      otPublicHours: adj?.otPublicHours ?? 0,
      // HOURLY gross = workedHours × rate. MONTHLY ignores this for basic
      // pay (paid by salary, docked via the unpaid-leave deduction line).
      workedHours: displayWorkedHours,
      // Configured working days — used to count eligible paid days for a
      // partial (join/leave) month under the 26-day rule.
      workingDaySet: parseWorkingDays(e.primaryProject?.workingDays ?? null),
      // Reimbursements: pre-attached PayrollRunClaim rows for this
      // employee. The claim id flows through to the generated
      // PayslipLineItem's `claimId` FK for traceability.
      reimbursements: reimbursementsByEmp.get(e.employeeProfileId) ?? [],
      // One-off deductions are now merged into `fixedAllowances`
      // above so they go through the category-aware path. Keep the
      // engine input empty — no double-counting. (Unpaid leave is
      // one of those line items now — category `deduct_unpaid_leave`.)
      manualDeductions: [],
      // PCB year-to-date inputs (this year's SUBMITTED payslips +
      // prev-employer TP3-like carryover).
      ytdTaxable: ytd?.ytdTaxable ?? 0,
      ytdEpf: ytd?.ytdEpf ?? 0,
      ytdPcb: ytd?.ytdPcb ?? 0,
      ytdZakat: ytd?.ytdZakat ?? 0,
      ytdSocsoEis: ytd?.ytdSocsoEis ?? 0,
      // YTD per-category allowance totals — drives taxExemptLimit
      // enforcement for parking / childcare / award etc. caps.
      ytdAllowanceByCategory: ytd?.ytdAllowanceByCategory ?? {},
    })

    return {
      employeeProfileId: e.employeeProfileId,
      payrollProfileId: e.profile.id,
      snapshotName: e.name,
      snapshotEmployeeId: e.employeeId,
      snapshotPosition: e.jobTitle,
      snapshotSalaryType: e.profile.salaryType,
      snapshotMonthlySalary: e.profile.monthlySalary,
      snapshotHourlyRate: e.profile.hourlyRate,
      snapshotNationality: e.profile.nationality,
      snapshotIsResident: e.profile.isResident,
      snapshotEpfRates: result.epfRatesSnapshot,
      basicPay: result.basicPay,
      proratedPay: result.proratedPay,
      // Display-only attendance figures (do not affect pay above).
      workedHours: displayWorkedHours,
      expectedHours: displayExpectedHours,
      unpaidLeaveDays: unpaidLeaveByEmp.get(e.employeeProfileId) ?? 0,
      proratedFactor: result.proratedFactor,
      proratedDays: result.proratedDays,
      totalWorkingDays: result.totalWorkingDays,
      otNormalHours: result.otNormalHours,
      otRestHours: result.otRestHours,
      otPublicHours: result.otPublicHours,
      otPay: result.otPay,
      totalAllowances: result.totalAllowances,
      totalBenefitsInKind: result.totalBenefitsInKind,
      totalReimbursements: result.totalReimbursements,
      totalDeductions: result.totalDeductions,
      epfEmployee: result.epfEmployee,
      epfEmployer: result.epfEmployer,
      socsoEmployee: result.socsoEmployee,
      socsoEmployer: result.socsoEmployer,
      eisEmployee: result.eisEmployee,
      eisEmployer: result.eisEmployer,
      pcb: result.pcb,
      hrdf: result.hrdf,
      hrdfWage: result.hrdfWage,
      zakat: result.zakat,
      grossPay: result.grossPay,
      netPay: result.netPay,
      totalCostToEmployer: result.totalCostToEmployer,
      lineItems: result.lineItems,
    }
  })

  const count = await payslipRepository.replacePayslipsForRun({
    payrollRunId: run.id,
    payslips,
  })

  await payslipRepository.refreshRunTotals({ payrollRunId: run.id })
  // Clear the pending-mutation flag — fresh payslips now reflect the
  // run state, so the stale-run banner / Submit lockout drops away
  // until the next mutation.
  await payrollRunRepository.clearMutated(run.id)

  await bustPayrollCaches({ organizationId: orgId })
  return { count }
}

// ─── Payslip read paths ──────────────────────────────────────────────────

/**
 * Extended detail-page data for the run page — adds the list of
 * payslips, the list of claim attachments, and the list of further
 * attachable claims so the admin can manage reimbursements in one
 * place.
 */
/** Lightweight summary of a PayrollRunAdjustment, for inline
 *  display on the "ready employees" table BEFORE payroll generation.
 *  Mirrors what the admin tends to glance at: OT hour totals + how
 *  many one-off line items + whether any recurring allowance is
 *  overridden for this run. */
export type RunEmployeeAdjustmentSummary = {
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  /// Salary type — drives whether HRS shows as a % (MONTHLY) or as
  /// absolute hours (HOURLY) in the run table.
  salaryType: SalaryType
  /// Resolved regular working hours (admin override ?? auto from
  /// attendance + paid leave). Null when no attendance data exists.
  workedHours: number | null
  /// Leave-adjusted expected hours (MONTHLY only). Null otherwise.
  expectedHours: number | null
  /// `workedHours / expectedHours` as a percentage (MONTHLY only).
  attendancePercent: number | null
  /// Count of manual ALLOWANCE-kind line items.
  allowanceCount: number
  /// Count of manual DEDUCTION-kind line items.
  deductionCount: number
  /// Count of recurring fixed-allowance rows the admin overrode for
  /// this run (amount changed or skipped).
  overrideCount: number
  /// Whether the admin has left an audit note on this adjustment.
  hasNote: boolean
}

export type PayrollRunDetailWithPayslipsPageData = {
  organizationName: string
  run: PayrollRunRow
  employees: Array<
    PayrollEmployeeRow & {
      ready: boolean
      /// Per-run adjustment summary. Null when the admin hasn't
      /// edited OT or added any line items for this employee yet.
      adjustment: RunEmployeeAdjustmentSummary | null
    }
  >
  payslips: PayslipRow[]
  attachments: PayrollRunClaimRow[]
  attachableClaims: AttachableClaimRow[]
  /// True when the run has payslips on file BUT something has
  /// changed since they were generated — i.e. an adjustment row or a
  /// claim attachment was created/updated after the latest payslip
  /// generation. UI uses this to disable "Submit payroll" and prompt
  /// the admin to re-run first so the payslips reflect the latest
  /// state. False when the run has never been generated yet (the
  /// generic "no payslips" empty state handles that), and false when
  /// everything's in sync.
  isStale: boolean
}

export async function getPayrollRunDetailWithPayslipsPageData(input: {
  runId: string
}): Promise<PayrollRunDetailWithPayslipsPageData | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 1-hour TTL — keyed on runId so each run has its own slot. Every
  // payroll mutation (generate, adjustment save, attach/detach, status
  // transition, Xero sync) calls `bustPayrollCaches({ organizationId })`.
  // The version segment intentionally bypasses older cached payloads:
  //  - v2 added the "hide already-Xero-synced claims" filter
  //  - v3 added per-employee working-hours (HRS %) + salary-type fields
  //  - v4 made attendance authoritative (no attendance → 0%, not blank)
  //  - v5 gated HRS on policy attendance access ("—" + full pay when off)
  //  - v6 made HRS display-only (pay reverted to day-based proration)
  //  - v7 force-refresh so payslips carry worked/expected hours for HRS
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "run-detail:v7", input.runId),
    3600,
    () => loadPayrollRunDetailWithPayslipsPageData(input, orgId),
  )
}

async function loadPayrollRunDetailWithPayslipsPageData(
  input: { runId: string },
  orgId: string,
): Promise<PayrollRunDetailWithPayslipsPageData | null> {
  const base = await getPayrollRunDetailPageData(input)
  if (!base) return null

  const [payslips, attachments, attachableClaims, adjustments, readyProfiles, policies] =
    await Promise.all([
      payslipRepository.listForRun(input.runId),
      payrollRunClaimRepository.listForRun(input.runId),
      payrollRunClaimRepository.listAttachableForOrg({
        organizationId: orgId,
        excludeAttached: true,
      }),
      payrollRunAdjustmentRepository.listForRun(input.runId),
      payrollProfileRepository.listReadyForPayroll(orgId),
      policyRepository.listForOrganization(orgId),
    ])

  // Join/leave dates come from the ready payroll profiles (only ready
  // employees generate a payslip, so only they need an HRS figure).
  const joinLeaveByEmp = new Map(
    readyProfiles.map((p) => [
      p.employeeProfileId,
      { joinDate: p.profile.joinDate, leaveDate: p.profile.leaveDate },
    ]),
  )
  // Whether attendance applies, per employee — drives whether the HRS
  // column shows a percentage/hours (attendance access) or "—" + full
  // pay (no attendance access). Keyed by employeeProfileId via policy.
  const policyById = new Map(policies.map((p) => [p.id, p]))
  const attendanceByEmp = new Map(
    readyProfiles.map((p) => [
      p.employeeProfileId,
      (p.policyId ? policyById.get(p.policyId)?.canAccessAttendance : undefined) ===
        true,
    ]),
  )

  // Auto-computed working hours per employee (worked / scheduled /
  // paid-leave minutes) so the table can show the HRS figure that will
  // apply at generation — even before the admin opens the dialog.
  const hoursByEmp = await attendanceRepository.getPayrollHoursForProfiles({
    organizationId: orgId,
    periodYear: base.run.periodYear,
    periodMonth: base.run.periodMonth,
    employees: base.employees.map((e) => ({
      employeeProfileId: e.employeeProfileId,
      joinDate: joinLeaveByEmp.get(e.employeeProfileId)?.joinDate ?? null,
      leaveDate: joinLeaveByEmp.get(e.employeeProfileId)?.leaveDate ?? null,
    })),
  })

  // Project every employee into a serialisable adjustment summary,
  // keyed by employeeProfileId. The "Will be included" table reads
  // these so admins can see who has OT / line items / an HRS figure
  // set before clicking Generate. Ready employees always get a summary
  // (so the HRS column shows a % / hours / "—"); non-ready rows only
  // when they carry an adjustment.
  const summariesByEmp = new Map<string, RunEmployeeAdjustmentSummary>()
  for (const e of base.employees) {
    const empId = e.employeeProfileId
    const adj = adjustments.get(empId) ?? null
    const hrs = hoursByEmp.get(empId) ?? null
    const isMonthly = e.salaryType === "MONTHLY"
    // No hours basis unless the employee's policy grants attendance —
    // otherwise the HRS column shows "—" and pay is the full month.
    const attendanceApplies = attendanceByEmp.get(empId) === true
    const auto = attendanceApplies
      ? autoHoursFromMinutes({
          salaryType: e.salaryType,
          workedMin: hrs?.workedMin ?? 0,
          scheduledMin: hrs?.scheduledMin ?? 0,
          paidLeaveMin: hrs?.paidLeaveMin ?? 0,
        })
      : { workedHours: null, expectedHours: null }
    const workedHours = adj?.workedHours ?? auto.workedHours
    const expectedHours = isMonthly
      ? adj?.expectedHours ?? auto.expectedHours
      : null
    const attendancePercent = isMonthly
      ? attendancePercentOf(workedHours, expectedHours)
      : null

    let allowanceCount = 0
    let deductionCount = 0
    for (const li of adj?.manualLineItems ?? []) {
      if (li.kind === "ALLOWANCE") allowanceCount += 1
      else if (li.kind === "DEDUCTION") deductionCount += 1
    }
    let overrideCount = 0
    for (const v of Object.values(adj?.fixedAllowanceOverrides ?? {})) {
      if (v.skip || v.amount != null) overrideCount += 1
    }

    if (!e.ready && adj == null) continue

    summariesByEmp.set(empId, {
      otNormalHours: adj?.otNormalHours ?? 0,
      otRestHours: adj?.otRestHours ?? 0,
      otPublicHours: adj?.otPublicHours ?? 0,
      salaryType: e.salaryType,
      workedHours,
      expectedHours,
      attendancePercent,
      allowanceCount,
      deductionCount,
      overrideCount,
      hasNote:
        typeof adj?.notes === "string" && adj.notes.trim().length > 0,
    })
  }

  const enrichedEmployees = base.employees.map((e) => ({
    ...e,
    adjustment: summariesByEmp.get(e.employeeProfileId) ?? null,
  }))

  // ── Stale-run guard ──────────────────────────────────────────────
  // The payslips are computed-once snapshots. If the admin edits an
  // adjustment OR adds/removes a claim attachment AFTER generation,
  // the on-screen payslips no longer reflect reality. We mark the
  // run "stale" so the run page can disable Submit + nudge the admin
  // to re-run.
  //
  // `run.lastMutatedAt` is bumped by every content mutation (attach,
  // detach, adjustment save/clear). Each Generate press freshens
  // every payslip's `createdAt`. If lastMutatedAt is newer than the
  // most-recent payslip, the run is stale.
  //
  // Detach is now correctly covered: previously we compared against
  // attachment.createdAt which doesn't change when the attachment is
  // deleted, so detach didn't mark stale. lastMutatedAt fixes that.
  let isStale = false
  if (payslips.length > 0 && base.run.lastMutatedAt != null) {
    const latestGeneration = payslips
      .map((p) => p.createdAt)
      .reduce((acc, v) => (v > acc ? v : acc), payslips[0]!.createdAt)
    if (base.run.lastMutatedAt > latestGeneration) {
      isStale = true
    }
  }

  return {
    ...base,
    employees: enrichedEmployees,
    payslips,
    attachments,
    attachableClaims,
    isStale,
  }
}

// ─── Bank disbursement (Phase 10) ────────────────────────────────────────

/**
 * One row per payslip in the format banks expect for bulk transfer
 * uploads. Built from PayrollProfile snapshots on the run via a
 * fresh lookup against the live profile — banks need the *current*
 * account info, not the snapshot from generation time. If the
 * employee updates their account between generate and submit, the
 * latest details win.
 */
export type DisbursementRow = {
  sequence: number
  employeeCode: string
  employeeName: string
  bankName: string
  accountHolderName: string
  accountNumber: string
  currency: string
  netAmount: number
  reference: string
}

export async function getPayrollDisbursementRows(input: {
  runId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  rows: DisbursementRow[]
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  // Pull every payslip on the run + the LIVE bank details from the
  // employee's PayrollProfile (not the snapshot — banks want current
  // account info).
  const payslips = await prisma.payslip.findMany({
    where: { payrollRunId: run.id },
    orderBy: { snapshotEmployeeId: "asc" },
    include: {
      payrollProfile: {
        select: {
          bankName: true,
          bankAccountHolderName: true,
          bankAccountNumber: true,
        },
      },
    },
  })

  const [org] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
  ])

  const periodTag = `${run.periodYear}${String(run.periodMonth).padStart(2, "0")}`
  const rows: DisbursementRow[] = payslips.map((p, i) => {
    return {
      sequence: i + 1,
      employeeCode: p.snapshotEmployeeId,
      employeeName: p.snapshotName,
      bankName: p.payrollProfile?.bankName ?? "",
      accountHolderName:
        p.payrollProfile?.bankAccountHolderName ?? p.snapshotName,
      accountNumber: p.payrollProfile?.bankAccountNumber ?? "",
      currency: "MYR",
      netAmount: Number(p.netPay) || 0,
      reference: `Payroll ${periodTag} ${p.snapshotEmployeeId}`,
    }
  })

  return {
    organizationName: org?.name ?? "",
    run,
    rows,
  }
}

// ─── Per-employee adjustments (Phase 7) ─────────────────────────────────

/**
 * Page-data for the per-employee adjustment form. Returns the
 * employee identity, the existing adjustment row (or null), and the
 * parent run so the form can render with full context.
 */
export async function getPayrollAdjustmentPageData(input: {
  runId: string
  employeeProfileId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  employee: {
    employeeProfileId: string
    userId: string
    employeeCode: string
    name: string
    email: string
    jobTitle: string
    salaryType: "MONTHLY" | "HOURLY"
    monthlySalary: number | null
    hourlyRate: number | null
  }
  /// Profile-level recurring adjustments — shown read-only on the form
  /// so admins can override them per-run (Phase 18).
  fixedAllowances: FixedAllowance[]
  adjustment: PayrollRunAdjustmentData | null
  /// Auto-computed regular working hours from attendance + paid leave.
  /// The form prefills with these when the admin hasn't set an override.
  /// Nulls when no attendance data exists (legacy day-based proration).
  autoHours: {
    workedHours: number | null
    expectedHours: number | null
    attendancePercent: number | null
  }
  /// Active loan installments that auto-deduct for THIS run's period.
  /// Shown read-only in the modal (editing happens on the Loans page).
  loans: Array<{ id: string; label: string; amount: number }>
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  // Resolve the employee identity + payroll profile (for compensation
  // context shown in the form header).
  const profileRow = await prisma.employeeProfile.findFirst({
    where: {
      id: input.employeeProfileId,
      user: { organizationId: orgId },
    },
    select: {
      id: true,
      employeeId: true,
      jobTitle: true,
      policy: { select: { canAccessAttendance: true } },
      user: { select: { id: true, name: true, email: true } },
      payrollProfile: {
        select: {
          salaryType: true,
          monthlySalary: true,
          hourlyRate: true,
        },
      },
    },
  })
  if (!profileRow) return null

  const [org, adjustment, payrollProfile, activeLoans] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunAdjustmentRepository.getOne({
      payrollRunId: run.id,
      employeeProfileId: input.employeeProfileId,
    }),
    // Pulled via the repo so the JSON column is already parsed +
    // typed. Used by the form to render the per-run overrides card.
    payrollProfileRepository.getByEmployeeProfileId(input.employeeProfileId),
    employeeLoanRepository.listActiveForOrganization(orgId),
  ])

  // Loan installments that fall on this run's period for this employee.
  // Surfaced read-only in the modal with a link to the Loans page.
  const loans = activeLoans
    .filter((l) => l.employeeProfileId === input.employeeProfileId)
    .map((l) => ({
      id: l.id,
      label: `Loan repayment (${formatLoanPeriodLabel(
        l.startYear,
        l.startMonth,
      )} start)`,
      amount: loanInstallmentForPeriod(l, run.periodYear, run.periodMonth),
    }))
    .filter((l) => l.amount > 0)

  const salaryType =
    (profileRow.payrollProfile?.salaryType as "MONTHLY" | "HOURLY") ?? "MONTHLY"
  // Only compute an attendance-based default when the employee's policy
  // grants attendance access; otherwise the HRS field is left empty and
  // the run pays the full month (day-based proration).
  const attendanceApplies = profileRow.policy?.canAccessAttendance === true
  const hoursMap = attendanceApplies
    ? await attendanceRepository.getPayrollHoursForProfiles({
        organizationId: orgId,
        periodYear: run.periodYear,
        periodMonth: run.periodMonth,
        employees: [
          {
            employeeProfileId: profileRow.id,
            joinDate: payrollProfile?.joinDate ?? null,
            leaveDate: payrollProfile?.leaveDate ?? null,
          },
        ],
      })
    : null
  const hrs = hoursMap?.get(profileRow.id) ?? null
  const auto = attendanceApplies
    ? autoHoursFromMinutes({
        salaryType,
        workedMin: hrs?.workedMin ?? 0,
        scheduledMin: hrs?.scheduledMin ?? 0,
        paidLeaveMin: hrs?.paidLeaveMin ?? 0,
      })
    : { workedHours: null, expectedHours: null }
  const autoHours = {
    workedHours: auto.workedHours,
    expectedHours: auto.expectedHours,
    attendancePercent:
      salaryType === "MONTHLY"
        ? attendancePercentOf(auto.workedHours, auto.expectedHours)
        : null,
  }

  return {
    organizationName: org?.name ?? "",
    run,
    employee: {
      employeeProfileId: profileRow.id,
      userId: profileRow.user.id,
      employeeCode: profileRow.employeeId,
      name: profileRow.user.name,
      email: profileRow.user.email,
      jobTitle: profileRow.jobTitle,
      salaryType:
        (profileRow.payrollProfile?.salaryType as "MONTHLY" | "HOURLY") ??
        "MONTHLY",
      monthlySalary: profileRow.payrollProfile?.monthlySalary
        ? Number(profileRow.payrollProfile.monthlySalary)
        : null,
      hourlyRate: profileRow.payrollProfile?.hourlyRate
        ? Number(profileRow.payrollProfile.hourlyRate)
        : null,
    },
    fixedAllowances: payrollProfile?.fixedAllowances ?? [],
    adjustment,
    autoHours,
    loans,
  }
}

/**
 * Upsert an adjustment row. Verifies the run is in this org + still
 * DRAFT before writing.
 */
export async function savePayrollAdjustment(input: {
  runId: string
  employeeProfileId: string
  patch: Parameters<typeof payrollRunAdjustmentRepository.upsert>[0]["patch"]
}): Promise<PayrollRunAdjustmentData> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run is submitted — revert it to draft before editing adjustments.",
    )
  }

  const result = await payrollRunAdjustmentRepository.upsert({
    payrollRunId: run.id,
    employeeProfileId: input.employeeProfileId,
    patch: input.patch,
  })
  // Bump the run's lastMutatedAt so the staleness check picks up the
  // change and the run page shows the "re-run before submit" banner.
  await payrollRunRepository.markMutated(run.id)
  await bustPayrollCaches({ organizationId: orgId })
  return result
}

/**
 * Clear the entire adjustment row for an employee on this run.
 */
export async function clearPayrollAdjustment(input: {
  runId: string
  employeeProfileId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run is submitted — revert it to draft before clearing adjustments.",
    )
  }

  await payrollRunAdjustmentRepository.deleteOne({
    payrollRunId: run.id,
    employeeProfileId: input.employeeProfileId,
  })
  await payrollRunRepository.markMutated(run.id)
  await bustPayrollCaches({ organizationId: orgId })
}

// ─── Claim attachment mutations ──────────────────────────────────────────

/**
 * Attach a SYNCED, PERSONAL paymentType claim to a draft payroll run.
 * Snapshots the claim's title + amount at attach time so later edits
 * to the claim don't change payroll history.
 */
export async function attachClaimToPayrollRun(input: {
  runId: string
  claimId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // 1. Verify the run exists in this org and is still DRAFT.
  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run has been submitted and can no longer accept new reimbursements.",
    )
  }

  // 2. Verify the claim, scoped to the same org.
  const claim = await payrollRunClaimRepository.getClaimForAttach({
    claimId: input.claimId,
    organizationId: orgId,
  })
  if (!claim) throw new Error("Claim not found in this organisation.")
  if (claim.alreadyAttachedRunId) {
    throw new Error(
      "This claim is already attached to a payroll run. Detach it first.",
    )
  }
  if (claim.status !== "REVIEWED") {
    throw new Error(
      "Only fully-reviewed claims can be added to payroll. Approve the claim first.",
    )
  }
  // The old guard required `xeroSyncStatus === "SYNCED"` here — dropped
  // when the workflow inverted: claims now flow REVIEWED → payroll
  // attach → submit → (future) Xero sync. The "Ready for payroll"
  // page (and `listAttachableForOrg`) already filter on REVIEWED +
  // PERSONAL, so allowing attach without a Xero sync matches the new
  // pipeline. See modules/payroll/infrastructure/payroll-run-claim.repository.ts
  // for the matching change on the read side.
  if (claim.paymentType !== "PERSONAL") {
    throw new Error(
      "Only PERSONAL-paymentType claims need reimbursing through payroll.",
    )
  }
  if (claim.xeroBillId || claim.xeroSpendMoneyId) {
    throw new Error(
      "This claim has already been synced to Xero, so it cannot be reimbursed through payroll.",
    )
  }
  if (!claim.employeeProfileId) {
    throw new Error(
      "The claim's submitter doesn't have an employee profile, so they can't be paid via payroll.",
    )
  }

  await payrollRunClaimRepository.attach({
    payrollRunId: run.id,
    claimId: claim.id,
    employeeProfileId: claim.employeeProfileId,
    label: claim.title,
    amount: claim.amount,
  })
  await payrollRunRepository.markMutated(run.id)
  await bustPayrollCaches({ organizationId: orgId })
}

/**
 * Detach a claim from whatever run it's attached to. Only allowed
 * while the run is still DRAFT.
 */
export async function detachClaimFromPayrollRun(input: {
  claimId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Verify the attached run (if any) belongs to this org AND is DRAFT.
  const claim = await payrollRunClaimRepository.getClaimForAttach({
    claimId: input.claimId,
    organizationId: orgId,
  })
  if (!claim) throw new Error("Claim not found in this organisation.")
  if (!claim.alreadyAttachedRunId) return // nothing to do

  const run = await payrollRunRepository.getByIdForOrg({
    id: claim.alreadyAttachedRunId,
    organizationId: orgId,
  })
  if (run && run.status !== "DRAFT") {
    throw new Error(
      "Cannot detach a claim from a submitted run. Reverse the run first.",
    )
  }

  await payrollRunClaimRepository.detach({ claimId: input.claimId })
  if (run) await payrollRunRepository.markMutated(run.id)
  await bustPayrollCaches({ organizationId: orgId })
}

/**
 * Single-payslip detail (snapshot + line items). Scoped to the admin's
 * active org via the parent run.
 */
export async function getPayrollPayslipDetailPageData(input: {
  payslipId: string
}): Promise<{
  organizationName: string
  payslip: PayslipData
  run: PayrollRunRow
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const payslip = await payslipRepository.getByIdForOrg({
    payslipId: input.payslipId,
    organizationId: orgId,
  })
  if (!payslip) return null

  const [org, run] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.getByIdForOrg({
      id: payslip.payrollRunId,
      organizationId: orgId,
    }),
  ])

  if (!run) return null

  return {
    organizationName: org?.name ?? "",
    payslip,
    run,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * An employee is "ready for payroll" when they have a complete
 * PayrollProfile, are not archived, and are not intentionally excluded
 * (salary = 0). This is the filter that decides who shows up on a
 * run's draft.
 */
function isReadyForPayroll(row: PayrollEmployeeRow): boolean {
  return row.hasProfile && row.isComplete && !row.isArchived && !row.isExcluded
}
