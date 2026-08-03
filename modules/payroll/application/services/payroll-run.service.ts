import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getOrSetCache } from "@/lib/cache"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { toNumber } from "@/lib/decimal"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
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
  IdType,
  PayrollEmployeeRow,
  SalaryType,
} from "@/modules/payroll/domain/models"
import type {
  AttachableClaimRow,
  ManualLineItem,
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
import {
  countActiveMalaysianEmployeesForOrg,
  hrdfTierFromCount,
} from "@/modules/payroll/application/services/payroll-settings.service"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  payslipRepository,
  type CreatePayslipInput,
} from "@/modules/payroll/infrastructure/payslip.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { unpaidLeaveDays } from "@/modules/leave/application/services/leave-balance.service"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import { deriveDailyHours, deriveHourlyRate } from "@/modules/payroll/domain/calc"

/**
 * Resolve the HRDF settings that should be passed into `calcPayslip`
 * for this run, given (a) the org's current active Malaysian
 * headcount and (b) the admin's stored preference.
 *
 * Tier logic lives in `payroll-settings.service.hrdfTierFromCount`
 * (single source of truth — same rule the settings UI shows):
 *
 *   - PART_I (>10 active Malaysian citizens): MANDATORY, force
 *     enabled at 1.0% regardless of the DB flag. Prevents the "admin
 *     forgot to save settings after the 11th hire" silent-skip bug.
 *   - PART_II (5-10): admin decides — honour whatever the DB has.
 *   - NOT_APPLICABLE (<5): force disabled.
 *
 * Called from every run path (single-employee preview, whole-run
 * generation, submit-time recompute) so the calc engine can't
 * accidentally read the stale flag.
 */
function resolveEffectiveHrdf(input: {
  activeMalaysianCount: number
  adminHrdfEnabled: boolean
  adminHrdfRate: number | null
}): { hrdfEnabled: boolean; hrdfRate: number | null } {
  const tier = hrdfTierFromCount(input.activeMalaysianCount)
  if (tier === "PART_I") return { hrdfEnabled: true, hrdfRate: 1 }
  if (tier === "NOT_APPLICABLE") return { hrdfEnabled: false, hrdfRate: 0 }
  return {
    hrdfEnabled: input.adminHrdfEnabled,
    hrdfRate: input.adminHrdfRate,
  }
}

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
  /// Active employee policies the signed-in admin may pick when
  /// creating a draft. Restricted admins (those with a non-null
  /// `policyIdScope`) only see policies they were granted; owners
  /// see all non-archived ones. Drives the "Create draft" dialog's
  /// policy multi-select.
  availablePolicies: Array<{ id: string; name: string; isDefault: boolean }>
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // Don't cache the runs page anymore — `availablePolicies` is
  // per-admin (different scope = different list) and including the
  // admin's scope tag in the cache key would balloon the keyspace.
  // This page is light (3 small queries) so we just bypass the cache.
  return loadPayrollRunsPageData(orgId)
}

async function loadPayrollRunsPageData(orgId: string): Promise<{
  organizationName: string
  runs: PayrollRunRow[]
  eligibleEmployeeCount: number
  availablePolicies: Array<{ id: string; name: string; isDefault: boolean }>
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  // Eligible employee count + available policies both restrict to the
  // admin's policy scope so a policy-restricted admin sees a correct
  // "X of Y employees ready" headline AND can only pick policies
  // they actually administer.
  const policyIdScope = await getActiveAdminPolicyScope()
  const [org, runs, employees, allPolicies] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.listForOrganization(orgId),
    payrollProfileRepository.listForOrganization(orgId, { policyIdScope }),
    policyRepository.listForOrganization(orgId),
  ])

  const allowedIds =
    policyIdScope === null ? null : new Set(policyIdScope)
  const availablePolicies = allPolicies
    .filter((p) => !p.archived)
    .filter((p) => allowedIds === null || allowedIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return {
    organizationName: org?.name ?? "",
    runs,
    // Pure profile-based count (no period gate) — "ready in general"
    // across the org. Wrapped in an arrow so Array.filter's index/array
    // args don't collide with isReadyForPayroll's optional `period`.
    eligibleEmployeeCount: employees.filter((e) => isReadyForPayroll(e)).length,
    availablePolicies,
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

  // Restrict the per-run "Will be included" / "Incomplete" preview to
  // the admin's policy scope. For SUBMITTED runs this also restricts
  // which payslips appear in the detail view.
  const adminPolicyIdScope = await getActiveAdminPolicyScope()
  const [org, run] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.getByIdForOrg({
      id: input.runId,
      organizationId: orgId,
      policyIdScope: adminPolicyIdScope,
    }),
  ])

  if (!run) return null

  // The displayed employee preview narrows by BOTH the admin's scope
  // AND the run's own scope, so the list matches what generation will
  // actually pay. `null` on either side means "no restriction".
  const effectivePolicyIdScope = intersectPolicyScopes(
    adminPolicyIdScope,
    run.policyIds,
  )
  // intersection = `[]` → admin + run combined produce no eligible
  // employees, but the run itself is visible. Short-circuit to skip
  // the listForOrganization query.
  const employees =
    Array.isArray(effectivePolicyIdScope) && effectivePolicyIdScope.length === 0
      ? []
      : await payrollProfileRepository.listForOrganization(orgId, {
          policyIdScope: effectivePolicyIdScope,
        })

  // Drop employees who aren't in this run's calendar window AT ALL —
  // joinDate after period end (haven't started) or leaveDate before
  // period start (already left). Without this filter they'd surface
  // under "needs setup" / "will be included" depending on profile
  // completeness, which is misleading: they're just not on this run.
  const periodStartMs = Date.UTC(run.periodYear, run.periodMonth - 1, 1)
  const periodEndMs = Date.UTC(
    run.periodYear,
    run.periodMonth,
    0,
    23,
    59,
    59,
    999,
  )
  const inPeriod = (e: (typeof employees)[number]) => {
    if (e.joinDate) {
      const ms = Date.parse(e.joinDate)
      if (!Number.isNaN(ms) && ms > periodEndMs) return false
    }
    if (e.leaveDate) {
      const ms = Date.parse(e.leaveDate)
      if (!Number.isNaN(ms) && ms < periodStartMs) return false
    }
    return true
  }

  return {
    organizationName: org?.name ?? "",
    run,
    employees: employees.filter(inPeriod).map((e) => ({
      ...e,
      ready: isReadyForPayroll(e, {
        year: run.periodYear,
        month: run.periodMonth,
      }),
    })),
  }
}

/// Combine two optional policy scopes (each `string[] | null`) into the
/// effective filter to apply. `null` is "no restriction"; an array is
/// the allow-list. Returns:
///   - `null` when both inputs are `null` (no filter at all)
///   - the non-null side when only one side restricts
///   - the set intersection when both restrict (possibly `[]`, which
///     callers treat as "no rows match")
function intersectPolicyScopes(
  a: string[] | null,
  b: string[] | null,
): string[] | null {
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  const bSet = new Set(b)
  return a.filter((id) => bSet.has(id))
}

// ─── Mutations ───────────────────────────────────────────────────────────

export async function createPayrollRunDraft(input: {
  periodYear: number
  periodMonth: number
  /// Employee policy ids this run covers. Empty array = pick at least
  /// one (form-enforced). `undefined` from older callers = no scope =
  /// org-wide (kept for backwards-compat with anything still calling
  /// the service without a picker).
  policyIds?: string[]
  /// EmployeeProfile ids to exclude from this run — layered on top
  /// of `policyIds`. Empty / omitted = include every member of the
  /// ticked policies. Only meaningful when `policyIds` is non-empty
  /// (an org-wide run has no picker to exclude from). Ids that don't
  /// belong to a member of one of the ticked policies are dropped
  /// with a validation error — no silent drops.
  excludedEmployeeProfileIds?: string[]
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

  // Normalise + validate the chosen policy scope. Restricted admins
  // (those with a non-null `policyIdScope` from AdminOrganization) can
  // only pick policies they were granted access to — silently dropping
  // out-of-scope ids would hide a misconfigured client; reject loudly
  // instead. Owners / legacy admins (null scope) can pick anything.
  let policyIds: string[] | null = null
  if (input.policyIds && input.policyIds.length > 0) {
    const adminScope = await getActiveAdminPolicyScope()
    if (adminScope !== null) {
      const allowed = new Set(adminScope)
      const outOfScope = input.policyIds.filter((id) => !allowed.has(id))
      if (outOfScope.length > 0) {
        throw new Error(
          "One or more selected policies are outside your granted access.",
        )
      }
    }
    // Confirm the ids actually belong to this org (defensive — admins
    // can't see other orgs' policies, but the server still verifies).
    const orgPolicies = await policyRepository.listForOrganization(orgId)
    const validOrgIds = new Set(orgPolicies.map((p) => p.id))
    const unknown = input.policyIds.filter((id) => !validOrgIds.has(id))
    if (unknown.length > 0) {
      throw new Error("Unknown policy ids in selection.")
    }
    // Dedupe + canonical-sort so the stored Json is stable across saves.
    policyIds = [...new Set(input.policyIds)].sort()
  }

  // Validate per-employee exclusions AFTER policy validation — the
  // list of "allowed to exclude" employees is precisely the members
  // of the ticked policies. Ids outside that set (typo, stale UI
  // state, or an admin tampering) are rejected loudly rather than
  // silently dropped, so a would-be paid employee never disappears
  // from the run without the admin noticing.
  let excludedEmployeeProfileIds: string[] | null = null
  if (
    input.excludedEmployeeProfileIds &&
    input.excludedEmployeeProfileIds.length > 0
  ) {
    if (policyIds === null) {
      // Excluding from an "org-wide" run has no picker to anchor on —
      // reject rather than guess which employees the ids belong to.
      throw new Error(
        "Per-employee exclusions require at least one policy to be selected.",
      )
    }
    const members = await payrollProfileRepository.listForOrganization(orgId, {
      policyIdScope: policyIds,
    })
    const memberIds = new Set(members.map((m) => m.employeeProfileId))
    const unknownExclude = input.excludedEmployeeProfileIds.filter(
      (id) => !memberIds.has(id),
    )
    if (unknownExclude.length > 0) {
      throw new Error(
        "Some excluded employees aren't members of the selected policies.",
      )
    }
    excludedEmployeeProfileIds = [
      ...new Set(input.excludedEmployeeProfileIds),
    ].sort()
  }

  const draft = await payrollRunRepository.createDraft({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
    policyIds,
    excludedEmployeeProfileIds,
  })
  await bustPayrollCaches({ organizationId: orgId })
  return draft
}

/**
 * Return the members of the given policies (for the current org),
 * shaped for the "New Draft" picker's per-policy expand list. Wraps
 * the profile repo so the picker doesn't need to know how to filter
 * by policy id — same auth + org-scope path the caller already goes
 * through for the picker's policy list itself.
 *
 * Returns `[]` when the admin's session can't be resolved, no active
 * org, or no policies passed. Restricted admins get their granted
 * subset only (the repo already scopes by `policyIdScope`, and this
 * caller pre-filters `policyIds` against the granted policies).
 */
export type PayrollRunPickerMember = {
  employeeProfileId: string
  userId: string
  name: string
  employeeId: string
  jobTitle: string
  /// True when the employee's salary is set to 0 — surfaced in the
  /// picker so the admin can see why unticking is a no-op (the run
  /// engine skips zero-salary profiles at compute anyway).
  isExcluded: boolean
}

/**
 * Return members grouped by policy id, so the "New Draft" picker can
 * render one expandable list per ticked policy without a second
 * round trip. Returns an empty map when the admin's session can't be
 * resolved, no active org, or no policies passed.
 *
 * Uses the profile repo's existing `policyIdScope` filter — no new
 * Prisma query needed here.
 */
export async function listMembersForPolicies(input: {
  policyIds: string[]
}): Promise<Record<string, PayrollRunPickerMember[]>> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return {}
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return {}
  if (input.policyIds.length === 0) return {}

  // Only accept ids the admin can see. Loud rejection lives in
  // `createPayrollRunDraft`; the picker read shouldn't fail the whole
  // page if a policy id was renamed mid-session.
  const adminScope = await getActiveAdminPolicyScope()
  const allowed =
    adminScope === null
      ? input.policyIds
      : input.policyIds.filter((id) => adminScope.includes(id))
  if (allowed.length === 0) return {}

  // Fetch one policy at a time so we can bucket members by policyId
  // in the return shape. Cheap — each policy is a single indexed
  // Prisma query, and the picker only expands a handful at once.
  //
  // Archived profiles are filtered out here (not just hidden in the
  // UI): they never get a payslip anyway (run engine skips them),
  // and surfacing them in the picker just clutters the list with
  // rows the admin can't meaningfully act on.
  const buckets: Record<string, PayrollRunPickerMember[]> = {}
  await Promise.all(
    allowed.map(async (policyId) => {
      const members = await payrollProfileRepository.listForOrganization(orgId, {
        policyIdScope: [policyId],
      })
      buckets[policyId] = members
        .filter((m) => !m.isArchived)
        .map((m) => ({
          employeeProfileId: m.employeeProfileId,
          userId: m.userId,
          name: m.name,
          employeeId: m.employeeId,
          jobTitle: m.jobTitle,
          isExcluded: m.isExcluded,
        }))
    }),
  )
  return buckets
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

  // Guard 2 — net pay can never be NEGATIVE. The calc already floors it
  // at 0 (you can't deduct an employee into debt — EA 1955 s.24), so a
  // truly-negative value here would be a calc bug, not a data problem —
  // hence still a hard block. A net of EXACTLY 0 (deductions swallowed
  // the whole pay) is allowed to submit: it's surfaced non-blockingly in
  // the run's "Needs attention" list via `netShortfall`, mirroring
  // Payroll Panda, which shows 0.00 and lets the run continue.
  const negative = payslips.filter((p) => p.netPay < 0)
  if (negative.length > 0) {
    const names = negative
      .slice(0, 5)
      .map((p) => p.snapshotName)
      .join(", ")
    const more = negative.length > 5 ? ` and ${negative.length - 5} more` : ""
    throw new Error(
      `Cannot submit — net pay is negative for: ${names}${more}. This shouldn't happen; re-run payroll and report it if it persists.`,
    )
  }

  // Guard 3 — chronological order. Two-part check:
  //
  //   3a. If a prior-month run EXISTS but isn't SUBMITTED yet
  //       (DRAFT / PENDING_APPROVAL), block. Admin can't skip ahead
  //       past a run they've already started.
  //
  //   3b. If there's NO prior-month run at all but the org has ANY
  //       earlier SUBMITTED run (i.e. this is a GAP, not the org's
  //       first run), block too. This closes the "Feb submitted while
  //       Jan didn't exist yet" bug — Feb's snapshot freezes with
  //       ytdTaxable=0 / ytdEpf=0 / ytdPcb=0 because getYtdForEmployee
  //       only sums SUBMITTED payslips, and no Jan payslips exist yet.
  //       Once Jan is finally submitted, Feb stays wrong forever —
  //       payslip snapshots are immutable.
  //
  // Both branches share the same actionable message: submit the
  // missing / draft prior period FIRST. Only when there's genuinely
  // no earlier submitted run (fresh org onboarding at some later
  // month) do we allow the current submit through.
  const prevPeriod =
    run.periodMonth > 1
      ? { year: run.periodYear, month: run.periodMonth - 1 }
      : { year: run.periodYear - 1, month: 12 }
  const previousRun = await payrollRunRepository.findByPeriod({
    organizationId: orgId,
    periodYear: prevPeriod.year,
    periodMonth: prevPeriod.month,
  })
  if (previousRun) {
    if (previousRun.status !== "SUBMITTED") {
      throw new Error(
        `Submit ${periodLabel(prevPeriod.year, prevPeriod.month)} first — payroll runs must be submitted in order, and that month's run is still ${PAYROLL_RUN_STATUS_LABELS[previousRun.status].toLowerCase()}.`,
      )
    }
  } else {
    // No prior-month run row — is this a genuine first-ever submission
    // for this org, or is a gap being papered over?
    const hasEarlierSubmitted =
      await payrollRunRepository.hasEarlierSubmittedRun({
        organizationId: orgId,
        periodYear: run.periodYear,
        periodMonth: run.periodMonth,
      })
    if (hasEarlierSubmitted) {
      throw new Error(
        `Create and submit ${periodLabel(prevPeriod.year, prevPeriod.month)} first — you have earlier submitted runs but no run for that month. Skipping it would freeze this month's PCB / EPF / SOCSO with zero YTD (payslip snapshots can't be edited after submission).`,
      )
    }
  }

  // Guard 4 — statutory readiness. Block the submit if Company Info or
  // any included employee is missing a field required by the statutory
  // document generators (PCB TXT, SOCSO+EIS, EPF CSV, CP8D, EA). Better
  // to fail loudly here, with an actionable list, than to wait for
  // post-submit document generation to throw a cryptic error.
  const { getPayrollRunReadiness } = await import(
    "@/modules/payroll/application/services/payroll-readiness.service"
  )
  const readiness = await getPayrollRunReadiness({ runId: input.runId })
  if (readiness && !readiness.ok) {
    const parts: string[] = []
    if (readiness.orgIssues.length > 0) {
      parts.push(
        `Company Info is missing: ${readiness.orgIssues
          .map((i) => i.label)
          .join(", ")}.`,
      )
    }
    if (readiness.employeeIssues.length > 0) {
      const names = readiness.employeeIssues
        .slice(0, 5)
        .map((e) => e.name)
        .join(", ")
      const more =
        readiness.employeeIssues.length > 5
          ? ` and ${readiness.employeeIssues.length - 5} more`
          : ""
      parts.push(
        `${readiness.employeeIssues.length} employee(s) need required fields filled (${names}${more}).`,
      )
    }
    throw new Error(
      `Can't submit — fix these first: ${parts.join(" ")} Open Payroll Settings → Company Info and the highlighted employee profiles, then try again.`,
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
export type ApprovePayrollRunResult = {
  xeroSync?:
    | { status: "synced"; manualJournalId: string; narration: string }
    | { status: "skipped"; message: string }
    | { status: "error"; message: string }
}

export async function approvePayrollRun(input: {
  runId: string
}): Promise<ApprovePayrollRunResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")
  return approvePayrollRunCore({
    orgId,
    runId: input.runId,
    approverId: session.userId,
  })
}

/**
 * External-API variant of `approvePayrollRun`. Used by the partner
 * endpoint `POST /api/v1/payroll-runs/[id]/approve` where the caller
 * supplies the approving user's id (the `approvedByUserId` body field)
 * in lieu of a session.
 *
 * The route handler must already have validated:
 *   - `approverId` belongs to `organizationId`
 *   - The user has role ADMIN or OWNER
 * This service trusts those checks and just runs the same core flow.
 */
export async function approvePayrollRunAsUser(input: {
  organizationId: string
  runId: string
  approverId: string
}): Promise<ApprovePayrollRunResult> {
  return approvePayrollRunCore({
    orgId: input.organizationId,
    runId: input.runId,
    approverId: input.approverId,
  })
}

/**
 * Shared core for the two approval entry points. Validates that the
 * run exists, is in PENDING_APPROVAL, flips it to SUBMITTED, busts
 * caches, then best-effort-posts to Xero.
 */
async function approvePayrollRunCore(input: {
  orgId: string
  runId: string
  approverId: string
}): Promise<ApprovePayrollRunResult> {
  const orgId = input.orgId
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
    approvedById: input.approverId,
  })
  // Bust early — Xero sync below also mutates the run (xeroSyncStatus),
  // and any errors there bust again. The early bust guarantees the
  // status flip is visible even if sync hangs or the request aborts.
  await bustPayrollCaches({ organizationId: orgId })

  // Best-effort Xero sync. Lazy-imported to keep the payroll-run
  // service light when Xero isn't configured.
  const settings = await payrollSettingsRepository.getByOrgId(orgId)
  const result: ApprovePayrollRunResult = {}

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

  // Downloadable reports are rendered on demand when the admin opens the
  // downloads modal — nothing is pre-generated or stored on disk here.

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

  // Revert the target run plus every later submitted month. Reports are
  // rendered on demand (nothing cached on disk), so there's nothing to
  // clean up here beyond the run state itself.
  const runIdsToRevert = [input.runId, ...laterRuns.map((r) => r.id)]
  for (const id of runIdsToRevert) {
    await payrollRunRepository.revertToDraft({ id, organizationId: orgId })
  }

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
 * Delete a single IMPORTED payroll run (one month of YTD-migration
 * history). Imported runs are SUBMITTED, so the draft-delete path
 * refuses them — this is the only way to remove a wrongly-imported
 * month without re-uploading the whole year. Does NOT touch employee
 * salary or SalaryChange history; those are standing data, unaffected
 * by removing an imported run.
 */
export async function deleteImportedPayrollRun(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  await payrollRunRepository.deleteImportedRun({
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
    manualLineItems: {
      kind: string
      category: string
      label: string
      amount: number
      /// LHDN AR override — see `ManualLineItem.treatAsRecurring`.
      treatAsRecurring?: boolean
    }[]
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

  const [settings, employees, policies, attachments, activeLoans, orgHours, activeMalaysianCount] =
    await Promise.all([
      payrollSettingsRepository.getByOrgId(orgId),
      // When the run was scoped at draft creation, only its chosen
      // policies' employees are included in preview / generation.
      // Period window excludes employees whose joinDate is after this
      // month (haven't started) or whose leaveDate is before it (left).
      payrollProfileRepository.listReadyForPayroll(orgId, {
        policyIdScope: run.policyIds,
        period: { year: run.periodYear, month: run.periodMonth },
      }),
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
      // Live active-Malaysian count drives the HRDF tier so the calc
      // engine can't silently skip HRDF when the org has crossed >10
      // but the admin never re-saved payroll settings. See
      // `resolveEffectiveHrdf` at the top of this file.
      countActiveMalaysianEmployeesForOrg(orgId),
    ])

  const effectiveHrdf = resolveEffectiveHrdf({
    activeMalaysianCount,
    adminHrdfEnabled: settings?.hrdfEnabled ?? false,
    adminHrdfRate: settings?.hrdfRate ?? null,
  })

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
    // Preserve the per-item LHDN AR override so the validation guard
    // sees the same PCB bucket the actual calc will use.
    ...(li.treatAsRecurring ? { treatAsRecurring: true } : {}),
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
        // Loans repay a non-taxable disbursement, so this category has
        // `reducesBase: false` — the repayment must not shrink the
        // employee's EPF/SOCSO/EIS/PCB wage.
        category:
          "deduct_loan_repayment" as (typeof overriddenFixed)[number]["category"],
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
    ytdAllowableDeductions:
      ytdRaw.ytdAllowableDeductions +
      (isPrevForSameYear ? e.profile.prevAllowableDeductions ?? 0 : 0),
    ytdAllowanceByCategory: ytdRaw.ytdAllowanceByCategory,
  }

  const policy = e.policyId ? policies.find((p) => p.id === e.policyId) ?? null : null
  const cashOt = policy !== null && policy.otEnabled && policy.otMethod === "CASH"
  const calcSettings = {
    workingDaysRule: settings?.workingDaysRule ?? "TWENTY_SIX",
    defaultEpfEmployeeRate: settings?.defaultEpfEmployeeRate ?? 11,
    defaultEpfEmployerRate: settings?.defaultEpfEmployerRate ?? 13,
    hrdfEnabled: effectiveHrdf.hrdfEnabled,
    hrdfRate: effectiveHrdf.hrdfRate,
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
    // OT pay is now driven entirely by approved OT requests (auto-
    // emitted as `wages_overtime` line items in the main generation
    // path). Admin-typed OT hours from the adjustment row no longer
    // contribute to payroll, so the preview ignores them too.
    otNormalHours: 0,
    otRestHours: 0,
    otPublicHours: 0,
    workedHours: previewWorkedHours,
    workingDaySet: parseWorkingDays(e.primaryProject?.workingDays ?? null),
    reimbursements,
    manualDeductions: [],
    ytdTaxable: ytd.ytdTaxable,
    ytdEpf: ytd.ytdEpf,
    ytdPcb: ytd.ytdPcb,
    ytdZakat: ytd.ytdZakat,
    ytdSocsoEis: ytd.ytdSocsoEis,
    ytdAllowableDeductions: ytd.ytdAllowableDeductions,
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

  const [
    settings,
    employees,
    attachments,
    adjustments,
    policies,
    orgHours,
    activeLoans,
    activeMalaysianCount,
  ] = await Promise.all([
    payrollSettingsRepository.getByOrgId(orgId),
    // Honour the per-run policy scope picked at draft creation.
    // `null` (legacy / org-wide) pulls every eligible employee.
    // Period window excludes employees whose joinDate is after this
    // month or whose leaveDate is before it.
    payrollProfileRepository.listReadyForPayroll(orgId, {
      policyIdScope: run.policyIds,
      period: { year: run.periodYear, month: run.periodMonth },
    }),
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
    // Live active-Malaysian count → HRDF tier at run time. See
    // `resolveEffectiveHrdf` for how the tier maps to enabled/rate.
    countActiveMalaysianEmployeesForOrg(orgId),
  ])

  const effectiveHrdf = resolveEffectiveHrdf({
    activeMalaysianCount,
    adminHrdfEnabled: settings?.hrdfEnabled ?? false,
    adminHrdfRate: settings?.hrdfRate ?? null,
  })

  // Per-employee exclusions picked at draft creation. Layered on top
  // of `policyIdScope` (which the profile repo already applied). No-op
  // when the run has no exclusion list.
  const excludedSet = new Set(run.excludedEmployeeProfileIds ?? [])
  if (excludedSet.size > 0) {
    for (let i = employees.length - 1; i >= 0; i--) {
      if (excludedSet.has(employees[i].employeeProfileId)) {
        employees.splice(i, 1)
      }
    }
  }

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
    hrdfEnabled: effectiveHrdf.hrdfEnabled,
    hrdfRate: effectiveHrdf.hrdfRate,
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
      // Add prev-employer TP3-like carryover when the employee's prior
      // figures are tagged for this calendar year (typically a mid-year
      // joiner; for a rehire the prevEmploymentYear is set during
      // restore).
      //
      // joinedThisYear is no longer a precondition — rehires keep their
      // original join date from years past, but the carryover still
      // applies to the same-year prev figures. The
      // prevEmploymentYear === run.periodYear check is what actually
      // gates this carryover.
      const isPrevForSameYear =
        (e.profile.prevEmploymentYear ?? null) === run.periodYear
      // Rehire path: if the admin entered prev* as the TOTAL YTD
      // (including the period the employee already worked at THIS
      // employer this year), subtract this org's submitted-payslip YTD
      // before adding — otherwise we'd double-count.
      const subtractThisOrg = e.profile.prevIncludesPriorThisOrgPeriod === true
      const effPrevRem = subtractThisOrg
        ? Math.max(0, (e.profile.prevRemuneration ?? 0) - ytd.ytdTaxable)
        : (e.profile.prevRemuneration ?? 0)
      const effPrevEpf = subtractThisOrg
        ? Math.max(0, (e.profile.prevEpf ?? 0) - ytd.ytdEpf)
        : (e.profile.prevEpf ?? 0)
      const effPrevPcb = subtractThisOrg
        ? Math.max(0, (e.profile.prevPcb ?? 0) - ytd.ytdPcb)
        : (e.profile.prevPcb ?? 0)
      const effPrevZakat = subtractThisOrg
        ? Math.max(0, (e.profile.prevZakat ?? 0) - ytd.ytdZakat)
        : (e.profile.prevZakat ?? 0)
      // Prior-employer TP1 allowable-deduction carryover (ΣLP portion
      // from Borang TP3 §D). Same rehire-safe subtraction as the
      // taxable/EPF/PCB/zakat fields above.
      const effPrevAllowableDeductions = subtractThisOrg
        ? Math.max(
            0,
            (e.profile.prevAllowableDeductions ?? 0) -
              ytd.ytdAllowableDeductions,
          )
        : (e.profile.prevAllowableDeductions ?? 0)
      return {
        empId: e.employeeProfileId,
        // TP3 carryover: add the prev-employer figures to each YTD
        // bucket only when the employee's `prevEmploymentYear` equals
        // the current run's calendar year. Per LHDN MTD Spec § 10
        // (page 23) the TP3 form provides (Y-K), X, Z, ΣLP.
        ytdTaxable: ytd.ytdTaxable + (isPrevForSameYear ? effPrevRem : 0),
        ytdEpf: ytd.ytdEpf + (isPrevForSameYear ? effPrevEpf : 0),
        ytdPcb: ytd.ytdPcb + (isPrevForSameYear ? effPrevPcb : 0),
        ytdZakat: ytd.ytdZakat + (isPrevForSameYear ? effPrevZakat : 0),
        // Prev-employer SOCSO+EIS carryover is intentionally omitted —
        // the RM 350 cap saturates at typical contribution levels
        // within the first ~3-4 months, so a mid-year joiner converges
        // to the same answer with or without the prior-employer
        // figure. (We could add a `prevSocsoEis` profile field later
        // if needed for early-year joiners, but the PCB delta is
        // typically < RM 5 / month.)
        ytdSocsoEis: ytd.ytdSocsoEis,
        // TP1 relief accumulated — from this org's prior submitted
        // payslips PLUS the prior-employer TP3 carryover.
        ytdAllowableDeductions:
          ytd.ytdAllowableDeductions +
          (isPrevForSameYear ? effPrevAllowableDeductions : 0),
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

  // SKBBK opt-in snapshots from any pre-existing payslips on this run.
  // Empty map on a first-time compute; populated when the admin
  // re-opens an already-computed run to adjust something. The freeze
  // rule (see `Payslip.contributeToSkbbk` in the schema): recompute
  // reads the snapshot when present so a previously-remitted SKBBK
  // contribution never silently disappears from a submitted payslip
  // just because the employee toggled off since. Delete + recreate a
  // run drops the payslips (and their snapshots), so a genuine
  // "start over" naturally falls back to the live profile toggle.
  const skbbkSnapshots = await payslipRepository.getSkbbkSnapshotsForRun(run.id)

  // Per-employee worked minutes bucketed by day type (regardless of OT
  // approval status). Drives the HRS column on the run table: HRS now
  // shows `normalMin / 60` instead of the raw `durationMin` total, so
  // over-threshold (OT) time never inflates normal worked hours.
  const workedBucketsByEmp = new Map(
    await Promise.all(
      employees.map(
        async (e) =>
          [
            e.employeeProfileId,
            await attendanceRepository.getWorkedHoursBucketsForPeriod({
              employeeId: e.userId,
              from: periodFrom,
              to: periodTo,
            }),
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
      // Per-item LHDN AR override — propagates to calc.ts so the PCB
      // bucket reflects the admin's "treat as recurring" toggle.
      ...(li.treatAsRecurring ? { treatAsRecurring: true } : {}),
    }))

    // Auto-applied loan installments for this period. Routed through
    // the dedicated `deduct_loan_repayment` category so the repayment
    // does NOT reduce statutory wage bases (loan proceeds were never
    // taxed as income under Malaysian tax law — the wage earned is
    // unchanged when they're paid back). Admin-typed "Advance
    // Deduction" line items still route through `deduct_advance` and
    // keep their base-reducing behaviour.
    for (const loan of loansByEmp.get(e.employeeProfileId) ?? []) {
      const installment = loanInstallmentForPeriod(
        loan,
        run.periodYear,
        run.periodMonth,
      )
      if (installment > 0) {
        oneOffLines.push({
          category:
            "deduct_loan_repayment" as (typeof overriddenFixed)[number]["category"],
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

    // Compute dailyHours + calcSettings up front — needed both by the
    // OT auto-derive block below (for hourly-rate conversion) and by the
    // calcPayslip call further down.
    const calcSettings = calcSettingsForEmployee(e.policyId)
    const dailyHours = deriveDailyHours({
      project: e.primaryProject,
      org: orgHours,
    })

    // Auto OT line items: convert the admin-typed OT hours on the
    // per-run PayrollRunAdjustment (otNormalHours / otRestHours /
    // otPublicHours) into pay using the employee policy's CASH-OT
    // multipliers + their derived hourly rate. Emitted as
    // `wages_overtime` line items so the payslip shows them as a
    // line below base salary, mirroring the "Unpaid Leave" pattern.
    // TIME_BANK / OT-disabled policies skip this (no cash OT payable).
    const policyForOt = e.policyId ? policyById.get(e.policyId) ?? null : null
    const cashOt =
      policyForOt !== null &&
      policyForOt.otEnabled &&
      policyForOt.otMethod === "CASH"
    if (cashOt && policyForOt) {
      const ot = {
        normalHours: toNumber(adj?.otNormalHours, 0),
        restHours: toNumber(adj?.otRestHours, 0),
        publicHours: toNumber(adj?.otPublicHours, 0),
      }
      const otHourlyRate = deriveHourlyRate({
        salaryType: e.profile.salaryType,
        monthlySalary: e.profile.monthlySalary,
        hourlyRate: e.profile.hourlyRate,
        workingDays: workingDaysForPeriod({
          year: run.periodYear,
          month: run.periodMonth,
          rule: settings?.workingDaysRule ?? "TWENTY_SIX",
        }),
        dailyHours,
      })
      const wagesOtCategory =
        "wages_overtime" as (typeof overriddenFixed)[number]["category"]
      const fmtHours = (h: number) => {
        const rounded = Math.round(h * 100) / 100
        return Number.isInteger(rounded) ? `${rounded}h` : `${rounded}h`
      }
      // Snapshot the hourly rate on the label so admins can see the
      // formula the calc engine used (hours × RM/hour × multiplier).
      // Without this the payslip just shows the total, forcing the
      // admin to guess where a bumped OT figure came from.
      const fmtRate = (r: number) =>
        `RM ${r.toLocaleString("en-MY", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}/h`
      if (ot.normalHours > 0) {
        const amount =
          Math.round(
            ot.normalHours * otHourlyRate * policyForOt.otRateNormalDay * 100,
          ) / 100
        if (amount > 0) {
          oneOffLines.push({
            category: wagesOtCategory,
            name: `Overtime — ${fmtHours(ot.normalHours)} × ${fmtRate(otHourlyRate)} × ${policyForOt.otRateNormalDay}×`,
            amount,
          })
        }
      }
      if (ot.restHours > 0) {
        const amount =
          Math.round(
            ot.restHours * otHourlyRate * policyForOt.otRateRestDay * 100,
          ) / 100
        if (amount > 0) {
          oneOffLines.push({
            category: wagesOtCategory,
            name: `Overtime (Rest day) — ${fmtHours(ot.restHours)} × ${fmtRate(otHourlyRate)} × ${policyForOt.otRateRestDay}×`,
            amount,
          })
        }
      }
      if (ot.publicHours > 0) {
        const amount =
          Math.round(
            ot.publicHours *
              otHourlyRate *
              policyForOt.otRatePublicHoliday *
              100,
          ) / 100
        if (amount > 0) {
          oneOffLines.push({
            category: wagesOtCategory,
            name: `Overtime (Public holiday) — ${fmtHours(ot.publicHours)} × ${fmtRate(otHourlyRate)} × ${policyForOt.otRatePublicHoliday}×`,
            amount,
          })
        }
      }
    }

    // Resolve the effective SKBBK opt-in for this employee-on-this-run:
    // snapshot from a prior compute wins (freeze semantics), else the
    // live profile toggle. Captured once here and used both for the
    // calc branch below AND written back to Payslip.contributeToSkbbk
    // so subsequent recomputes keep the same value.
    const effectiveContributeToSkbbk =
      skbbkSnapshots.get(e.employeeProfileId) ?? e.profile.contributeToSkbbk

    const profileWithAdjAllowances = {
      ...e.profile,
      fixedAllowances: [...overriddenFixed, ...oneOffLines],
      contributeToSkbbk: effectiveContributeToSkbbk,
    }

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
    // HRS uses NORMAL minutes (capped per-day at policy threshold), not
    // raw `workedMin` — over-threshold OT time shows up in the OT
    // columns + the wages_overtime line item, not in the normal HRS
    // column. Falls back to total worked when the bucket helper returns
    // 0 (no records / no project info), so legacy data still surfaces.
    const workedBuckets = workedBucketsByEmp.get(e.employeeProfileId)
    const hrsNormalMin =
      workedBuckets && workedBuckets.normalMin > 0
        ? workedBuckets.normalMin
        : hrs?.workedMin ?? 0
    const auto = attendanceApplies
      ? autoHoursFromMinutes({
          salaryType: e.profile.salaryType,
          workedMin: hrsNormalMin,
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
      // OT is now emitted as `wages_overtime` line items above (driven
      // by APPROVED OT requests), so the engine's separate OT pay path
      // is zeroed out to avoid double-counting. Admin-typed
      // `adj?.otNormalHours` etc. are intentionally ignored — only
      // approved OT contributes to payroll.
      otNormalHours: 0,
      otRestHours: 0,
      otPublicHours: 0,
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
      // YTD TP1 relief — feeds ∑LP in the PCB formula.
      ytdAllowableDeductions: ytd?.ytdAllowableDeductions ?? 0,
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
      // OT hour columns (OT N / OT R / OT PH on the run table) mirror
      // the admin-typed values on this employee's PayrollRunAdjustment
      // — same source the wages_overtime line item is derived from.
      // The engine's separate OT path stays zeroed (see comment further
      // down) so `result.ot*Hours` is always 0; we surface the adj
      // values directly here so the columns aren't blank.
      otNormalHours: toNumber(adj?.otNormalHours, 0),
      otRestHours: toNumber(adj?.otRestHours, 0),
      otPublicHours: toNumber(adj?.otPublicHours, 0),
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
      skbbkEmployee: result.skbbkEmployee,
      skbbkWage: result.skbbkWage,
      // Persist the resolved opt-in as this payslip's frozen snapshot.
      contributeToSkbbk: effectiveContributeToSkbbk,
      pcb: result.pcb,
      cp38: result.cp38,
      voluntaryPcb: result.voluntaryPcb,
      pcbCalculation: result.pcbCalculation,
      hrdf: result.hrdf,
      hrdfWage: result.hrdfWage,
      zakat: result.zakat,
      grossPay: result.grossPay,
      netPay: result.netPay,
      netShortfall: result.netShortfall,
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
  /// Expired-leave cash-outs already attached to this run.
  attachedLeaveCashouts: PendingLeaveCashout[]
  /// Eligible expired-leave rows that haven't been attached to any
  /// run yet — admin can attach them from the "Expired leave cash-out"
  /// card on the run detail page.
  attachableLeaveCashouts: PendingLeaveCashout[]
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

  // Per-admin policy scope tagged into the cache key so two restricted
  // admins viewing the same submitted run see only their employees.
  const policyIdScope = await getActiveAdminPolicyScope()
  const scopeTag =
    policyIdScope === null
      ? "_all"
      : `p:${[...policyIdScope].sort().join(",")}`

  // 1-hour TTL — keyed on runId so each run has its own slot. Every
  // payroll mutation (generate, adjustment save, attach/detach, status
  // transition, Xero sync) calls `bustPayrollCaches({ organizationId })`.
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "run-detail:v7", input.runId, scopeTag),
    3600,
    () => loadPayrollRunDetailWithPayslipsPageData(input, orgId, policyIdScope),
  )
}

async function loadPayrollRunDetailWithPayslipsPageData(
  input: { runId: string },
  orgId: string,
  policyIdScope: string[] | null = null,
): Promise<PayrollRunDetailWithPayslipsPageData | null> {
  const base = await getPayrollRunDetailPageData(input)
  if (!base) return null

  const [payslips, attachments, attachableClaims, adjustments, readyProfiles, policies] =
    await Promise.all([
      payslipRepository.listForRun(input.runId, { policyIdScope }),
      payrollRunClaimRepository.listForRun(input.runId),
      payrollRunClaimRepository.listAttachableForOrg({
        organizationId: orgId,
        excludeAttached: true,
      }),
      payrollRunAdjustmentRepository.listForRun(input.runId),
      // Period window excludes employees whose joinDate is after this
      // month (haven't started — they shouldn't show in the "Will be
      // included" preview either) or whose leaveDate is before it.
      payrollProfileRepository.listReadyForPayroll(orgId, {
        policyIdScope,
        period: {
          year: base.run.periodYear,
          month: base.run.periodMonth,
        },
      }),
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

  // Load expired-leave cash-out lists in parallel (admin-only data;
  // safe to read here because getPayrollRunDetailPageData already
  // checked the session).
  const cashouts = await listPendingLeaveCashoutsForRun({
    runId: input.runId,
  })

  return {
    ...base,
    employees: enrichedEmployees,
    payslips,
    attachments,
    attachableClaims,
    attachedLeaveCashouts: cashouts.attached,
    attachableLeaveCashouts: cashouts.available,
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
  /// Live ID details from the employee's payroll profile — used by the
  /// PB ECP file's "ID Type" + "Bene Identification No / Passport"
  /// columns. Null when the employee hasn't filled them in.
  idType: IdType | null
  idNumber: string | null
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
          idType: true,
          idNumber: true,
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
      idType: p.payrollProfile?.idType ?? null,
      idNumber: p.payrollProfile?.idNumber ?? null,
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
  /// Approved OT hours from the attendance system, bucketed by day
  /// type. The form prefills the OT fields with these when the admin
  /// hasn't typed a value yet. Zero across the board = no approved
  /// OT for this period.
  autoOt: {
    normalHours: number
    restHours: number
    publicHours: number
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

  const [org, storedAdjustment, payrollProfile, activeLoans] =
    await Promise.all([
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

  // IMPORTED runs never own a PayrollRunAdjustment row — their per-
  // employee allowances / deductions live on Payslip.lineItems instead
  // (the YTD importer writes them there). Synthesize a read-only
  // adjustment from those line items so the "View adjustments" modal
  // renders the imported breakdown instead of a misleading empty state.
  let adjustment = storedAdjustment
  if (!adjustment && run.source === "IMPORTED") {
    const payslip = await payslipRepository.getByRunAndEmployee({
      payrollRunId: run.id,
      employeeProfileId: input.employeeProfileId,
    })
    if (payslip && payslip.lineItems.length > 0) {
      adjustment = {
        id: `imported:${payslip.id}`,
        payrollRunId: run.id,
        employeeProfileId: input.employeeProfileId,
        otNormalHours: payslip.otNormalHours,
        otRestHours: payslip.otRestHours,
        otPublicHours: payslip.otPublicHours,
        workedHours: null,
        expectedHours: null,
        manualLineItems: payslip.lineItems.map((li) => ({
          kind: li.kind,
          category:
            li.category ??
            (li.kind === "DEDUCTION"
              ? "deduct_salary_adjustment"
              : li.kind === "REIMBURSEMENT"
                ? "wages_expense_claim"
                : "allowance_standard"),
          label: li.label,
          amount: li.amount,
        })),
        fixedAllowanceOverrides: {},
        notes: null,
        createdAt: payslip.createdAt,
        updatedAt: payslip.updatedAt,
      }
    }
  }

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

  // Approved OT minutes for this employee's period, converted to
  // hours for the form. Only fetched when the employee's policy
  // grants attendance access — otherwise the OT-approval path
  // isn't available to them anyway.
  const periodFromUtc = new Date(
    Date.UTC(run.periodYear, run.periodMonth - 1, 1),
  )
  const periodToUtc = new Date(
    Date.UTC(run.periodYear, run.periodMonth, 1),
  )
  const otMinutes = attendanceApplies
    ? await attendanceRepository.getApprovedOtMinutesForPeriod({
        employeeId: profileRow.user.id,
        from: periodFromUtc,
        to: periodToUtc,
      })
    : { normalOtMin: 0, restMin: 0, publicMin: 0 }
  const autoOt = {
    normalHours: Math.round(((otMinutes.normalOtMin ?? 0) / 60) * 100) / 100,
    restHours: Math.round(((otMinutes.restMin ?? 0) / 60) * 100) / 100,
    publicHours: Math.round(((otMinutes.publicMin ?? 0) / 60) * 100) / 100,
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
    autoOt,
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

// ─── Expired-leave cash-out (manual review at payroll time) ─────────────
//
// When `runMonthlyAccrual` sweeps an expired carry-forward row it now
// preserves `carriedExpiredDays` on the LeaveEntitlement. Admins can
// then attach those forfeited days to a draft payroll run as a
// `wages_leave_pay` line item, cashing the employee out for the days
// they would otherwise lose.
//
// Mirrors the existing claim-attach surface in shape: list available,
// admin clicks attach, line item lands on the run's adjustment.
// Detach reverses both writes (line item + LeaveEntitlement flags).

export type PendingLeaveCashout = {
  entitlementId: string
  employeeProfileId: string
  employeeName: string
  employeeEmail: string
  leaveTypeId: string
  leaveTypeCode: string
  /// The year the carry-forward came from — e.g. 2025 carry that
  /// expired in 2026 had `year = 2025` on the entitlement row.
  year: number
  expiredDays: number
  /// When the expiry sweep fired.
  expiredAt: Date
  /// Monthly salary at the time of computation. Null if the employee
  /// doesn't have a payroll profile or monthlySalary set — UI shows
  /// the row but the Attach button is disabled with a tooltip.
  monthlySalary: number | null
  /// The actual rate used to compute `suggestedAmount`. Mirrors the
  /// existing unpaid-leave deduction (monthlySalary / workingDaysBasis).
  dailyRate: number
  /// `expiredDays × dailyRate`, rounded to 2 decimals. Zero if
  /// monthlySalary is null.
  suggestedAmount: number
  /// Null = available to attach. Equal to `run.id` = already
  /// attached to this run (admin can detach). Equal to another run
  /// id = already attached elsewhere; this admin can't touch it
  /// from here.
  attachedRunId: string | null
  /// Snapshot of the amount that was attached (null if not attached).
  attachedAmount: number | null
}

export async function listPendingLeaveCashoutsForRun(input: {
  runId: string
}): Promise<{ available: PendingLeaveCashout[]; attached: PendingLeaveCashout[] }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { available: [], attached: [] }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { available: [], attached: [] }

  const prisma = getPrismaClient()
  if (!prisma) return { available: [], attached: [] }

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return { available: [], attached: [] }

  const settings = await payrollSettingsRepository.getByOrgId(orgId)
  const workingDays = workingDaysForPeriod({
    year: run.periodYear,
    month: run.periodMonth,
    rule: settings?.workingDaysRule ?? "TWENTY_SIX",
  })

  // Pull every LeaveEntitlement in the org that's expired-but-not-yet-
  // discarded — either available (not attached anywhere) or already
  // attached to this run (so we can render the "Attached" section).
  const rows = await prisma.leaveEntitlement.findMany({
    where: {
      carriedExpired: true,
      carriedExpiredDays: { gt: 0 },
      employee: { user: { organizationId: orgId } },
      OR: [
        { carriedCashedOutRunId: null },
        { carriedCashedOutRunId: input.runId },
      ],
    },
    include: {
      leaveType: { select: { id: true, code: true } },
      employee: {
        select: {
          id: true,
          user: { select: { name: true, email: true } },
          payrollProfile: { select: { monthlySalary: true } },
        },
      },
    },
    orderBy: [{ carriedExpiredAt: "desc" }],
  })

  const available: PendingLeaveCashout[] = []
  const attached: PendingLeaveCashout[] = []

  for (const r of rows) {
    const monthlySalary = r.employee.payrollProfile?.monthlySalary
      ? toNumber(r.employee.payrollProfile.monthlySalary, 0)
      : null
    const dailyRate =
      monthlySalary != null && workingDays > 0
        ? monthlySalary / workingDays
        : 0
    const expiredDays = r.carriedExpiredDays ?? 0
    const suggestedAmount =
      monthlySalary != null
        ? Math.round(dailyRate * expiredDays * 100) / 100
        : 0
    const row: PendingLeaveCashout = {
      entitlementId: r.id,
      employeeProfileId: r.employeeId,
      employeeName: r.employee.user.name,
      employeeEmail: r.employee.user.email,
      leaveTypeId: r.leaveTypeId,
      leaveTypeCode: r.leaveType.code,
      year: r.year,
      expiredDays,
      expiredAt: r.carriedExpiredAt ?? new Date(0),
      monthlySalary,
      dailyRate,
      suggestedAmount,
      attachedRunId: r.carriedCashedOutRunId,
      attachedAmount: r.carriedCashedOutAmount
        ? toNumber(r.carriedCashedOutAmount, 0)
        : null,
    }
    if (r.carriedCashedOutRunId === input.runId) attached.push(row)
    else available.push(row)
  }

  return { available, attached }
}

/// Attach one expired-leave row to a draft run. Adds a
/// `wages_leave_pay` manual line item to the run's PayrollRunAdjustment
/// for that employee, and stamps the LeaveEntitlement row with the
/// cash-out backlink so it doesn't reappear in subsequent runs.
export async function attachLeaveCashoutToRun(input: {
  runId: string
  entitlementId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run has been submitted and can no longer accept new cash-outs.",
    )
  }

  const settings = await payrollSettingsRepository.getByOrgId(orgId)
  const workingDays = workingDaysForPeriod({
    year: run.periodYear,
    month: run.periodMonth,
    rule: settings?.workingDaysRule ?? "TWENTY_SIX",
  })

  const entitlement = await prisma.leaveEntitlement.findFirst({
    where: {
      id: input.entitlementId,
      employee: { user: { organizationId: orgId } },
      carriedExpired: true,
      carriedExpiredDays: { gt: 0 },
      carriedCashedOutRunId: null,
    },
    include: {
      leaveType: { select: { code: true } },
      employee: {
        select: {
          id: true,
          user: { select: { name: true } },
          payrollProfile: { select: { monthlySalary: true } },
        },
      },
    },
  })
  if (!entitlement) {
    throw new Error(
      "This expired-leave row is no longer eligible for cash-out (already attached, or the days were already discarded).",
    )
  }
  const monthlySalary = entitlement.employee.payrollProfile?.monthlySalary
    ? toNumber(entitlement.employee.payrollProfile.monthlySalary, 0)
    : null
  if (monthlySalary == null || monthlySalary <= 0) {
    throw new Error(
      "Employee has no monthly salary on their payroll profile; cash-out requires a salary to compute the amount.",
    )
  }
  const expiredDays = entitlement.carriedExpiredDays ?? 0
  const dailyRate = monthlySalary / workingDays
  const amount = Math.round(dailyRate * expiredDays * 100) / 100

  // Read the current PayrollRunAdjustment so we can append the new
  // line item to the existing array (or start a fresh one).
  const existing = await payrollRunAdjustmentRepository.getOne({
    payrollRunId: run.id,
    employeeProfileId: entitlement.employee.id,
  })
  const previousLineItems = existing?.manualLineItems ?? []
  const newLineItem: ManualLineItem = {
    kind: "ALLOWANCE",
    category: "wages_leave_pay",
    label: `Annual leave cash-out (${expiredDays} day${
      expiredDays === 1 ? "" : "s"
    } from ${entitlement.year})`,
    amount,
    sourceEntitlementId: entitlement.id,
  }
  await payrollRunAdjustmentRepository.upsert({
    payrollRunId: run.id,
    employeeProfileId: entitlement.employee.id,
    patch: { manualLineItems: [...previousLineItems, newLineItem] },
  })
  await prisma.leaveEntitlement.update({
    where: { id: entitlement.id },
    data: {
      carriedCashedOutRunId: run.id,
      carriedCashedOutAt: new Date(),
      carriedCashedOutAmount: amount,
    },
  })
  await payrollRunRepository.markMutated(run.id)
  await bustPayrollCaches({ organizationId: orgId })
}

/// Detach a previously-attached cash-out. Removes the `wages_leave_pay`
/// line item from the run's adjustment and clears the LeaveEntitlement
/// backlink so the row reappears in "Available to attach".
export async function detachLeaveCashoutFromRun(input: {
  entitlementId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const entitlement = await prisma.leaveEntitlement.findFirst({
    where: {
      id: input.entitlementId,
      employee: { user: { organizationId: orgId } },
      carriedCashedOutRunId: { not: null },
    },
    select: { id: true, employeeId: true, carriedCashedOutRunId: true },
  })
  if (!entitlement) return // already detached
  const run = await payrollRunRepository.getByIdForOrg({
    id: entitlement.carriedCashedOutRunId!,
    organizationId: orgId,
  })
  if (run && run.status !== "DRAFT") {
    throw new Error(
      "Cannot detach a cash-out from a submitted run. Reverse the run first.",
    )
  }

  // Strip the line item by sourceEntitlementId from the adjustment.
  if (run) {
    const existing = await payrollRunAdjustmentRepository.getOne({
      payrollRunId: run.id,
      employeeProfileId: entitlement.employeeId,
    })
    if (existing) {
      const filtered = existing.manualLineItems.filter(
        (li) => li.sourceEntitlementId !== entitlement.id,
      )
      if (filtered.length !== existing.manualLineItems.length) {
        await payrollRunAdjustmentRepository.upsert({
          payrollRunId: run.id,
          employeeProfileId: entitlement.employeeId,
          patch: { manualLineItems: filtered },
        })
      }
    }
  }
  await prisma.leaveEntitlement.update({
    where: { id: entitlement.id },
    data: {
      carriedCashedOutRunId: null,
      carriedCashedOutAt: null,
      carriedCashedOutAmount: null,
    },
  })
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
function isReadyForPayroll(
  row: PayrollEmployeeRow,
  /// Optional period gate. When set, employees whose joinDate is AFTER
  /// the period end (haven't started) or whose leaveDate is BEFORE the
  /// period start (already left) are NOT ready for that run. Omit on
  /// non-run surfaces (e.g. the Payroll Runs list's "X eligible" tile)
  /// where the answer is "across all periods".
  period?: { year: number; month: number },
): boolean {
  if (!(row.hasProfile && row.isComplete && !row.isExcluded)) {
    return false
  }
  // Archived employees are excluded, EXCEPT a genuine dated leaver being
  // evaluated for a specific run period — they must still be paid for the
  // months they worked (full months before their last day + prorated final
  // month). The period gate below then excludes them once the run starts
  // after they left. This mirrors listReadyForPayroll in the profile repo so
  // the "will be included" preview matches who actually gets paid. Archived
  // profiles with no leaveDate, or evaluated with no period, stay excluded.
  if (row.isArchived) {
    const isDatedLeaver = Boolean(period && row.leaveDate)
    if (!isDatedLeaver) return false
  }
  if (period) {
    const periodStart = Date.UTC(period.year, period.month - 1, 1)
    const periodEnd = Date.UTC(
      period.year,
      period.month,
      0, // day 0 of next month = last day of this month
      23,
      59,
      59,
      999,
    )
    if (row.joinDate) {
      const join = Date.parse(row.joinDate)
      if (!Number.isNaN(join) && join > periodEnd) return false
    }
    if (row.leaveDate) {
      const leave = Date.parse(row.leaveDate)
      if (!Number.isNaN(leave) && leave < periodStart) return false
    }
  }
  return true
}
