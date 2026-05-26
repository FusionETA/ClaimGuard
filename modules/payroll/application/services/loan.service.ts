import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { key } from "@/lib/redis"
import {
  buildScheduleFromTerms,
  loanInstallmentBreakdown,
  loanScheduleSummary,
  validateSchedule,
  type EmployeeLoanData,
  type LoanInstallment,
  type LoanRepaymentMode,
  type LoanScheduleSummary,
  type LoanStatus,
} from "@/modules/payroll/domain/loans"
import { employeeLoanRepository } from "@/modules/payroll/infrastructure/employee-loan.repository"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * Admin-only services for staff loans / cash advances. A loan repays
 * via auto-applied monthly deductions on each payroll run (see
 * `generatePayrollPayslips` and `modules/payroll/domain/loans.ts`).
 */

export type LoanEmployeeOption = {
  employeeProfileId: string
  employeeId: string
  name: string
}

export type EmployeeLoanWithProgress = EmployeeLoanData & {
  summary: LoanScheduleSummary
  /// Per-installment rows with paid/unpaid flags (drives the edit
  /// dialog's breakdown view).
  breakdown: LoanInstallment[]
  /// Display status: a fully-repaid ACTIVE loan reads as "COMPLETED".
  derivedStatus: LoanStatus
}

export type LoansPageData = {
  loans: EmployeeLoanWithProgress[]
  employees: LoanEmployeeOption[]
}

async function requireAdminOrg(): Promise<{ orgId: string } | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null
  return { orgId }
}

/**
 * Flag every DRAFT payroll run whose period overlaps a loan window as
 * "mutated", so its already-generated payslips are treated as stale.
 * The submit guard then forces a re-run before the draft can be
 * submitted (otherwise it would post the OLD loan installment).
 */
async function markAffectedDraftsMutated(
  orgId: string,
  window: { startYear: number; startMonth: number; installmentCount: number },
): Promise<void> {
  const runs = await payrollRunRepository.listForOrganization(orgId)
  await Promise.all(
    runs
      .filter((r) => r.status === "DRAFT")
      .filter((r) => {
        const idx =
          (r.periodYear - window.startYear) * 12 +
          (r.periodMonth - window.startMonth)
        return idx >= 0 && idx < window.installmentCount
      })
      .map((r) => payrollRunRepository.markMutated(r.id)),
  )
}

/**
 * Loans list (with derived repayment progress + per-installment
 * breakdown) and the employee picker options for the create form.
 * Returns null when the caller isn't an admin with an active org.
 */
export async function getLoansPageData(): Promise<LoansPageData | null> {
  const ctx = await requireAdminOrg()
  if (!ctx) return null

  // 10-min TTL; busted by `bustPayrollCaches` (org payroll:* namespace)
  // on every loan create/edit/cancel and on run submissions (which
  // change repayment progress).
  return getOrSetCache(
    key("org", ctx.orgId, "payroll", "page", "loans"),
    600,
    () => loadLoansPageData(ctx.orgId),
  )
}

async function loadLoansPageData(orgId: string): Promise<LoansPageData> {
  const [loans, submittedPeriods, employees] = await Promise.all([
    employeeLoanRepository.listForOrganization(orgId),
    payrollRunRepository.listSubmittedPeriods(orgId),
    payrollProfileRepository.listReadyForPayroll(orgId),
  ])

  const withProgress: EmployeeLoanWithProgress[] = loans.map((loan) => {
    const summary = loanScheduleSummary(loan, submittedPeriods)
    const breakdown = loanInstallmentBreakdown(loan, submittedPeriods)
    const derivedStatus: LoanStatus =
      loan.status === "ACTIVE" && summary.fullyRepaid ? "COMPLETED" : loan.status
    return { ...loan, summary, breakdown, derivedStatus }
  })

  // `listReadyForPayroll` already excludes archived / excluded
  // employees, so the picker shows the same roster that runs see.
  const employeeOptions: LoanEmployeeOption[] = employees.map((e) => ({
    employeeProfileId: e.employeeProfileId,
    employeeId: e.employeeId,
    name: e.name,
  }))

  return { loans: withProgress, employees: employeeOptions }
}

function assertValidStart(startYear: number, startMonth: number) {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error("Start month must be between 1 and 12.")
  }
  if (!Number.isInteger(startYear) || startYear < 2000) {
    throw new Error("Invalid start year.")
  }
}

/**
 * Resolve the stored installment fields from the chosen mode:
 *   - FIXED  → equal split computed from `installmentCount`.
 *   - CUSTOM → an explicit per-month `schedule` (each month may differ);
 *              must sum to the principal.
 */
function resolveTerms(input: {
  mode: LoanRepaymentMode
  principalAmount: number
  installmentCount?: number | null
  schedule?: number[]
}): { installmentAmount: number; installmentCount: number; schedule: number[] } {
  const principal = Math.round(input.principalAmount * 100) / 100
  if (input.mode === "CUSTOM") {
    const sched = (input.schedule ?? []).map((n) => Math.round(n * 100) / 100)
    if (sched.length === 0) {
      throw new Error("Add at least one installment.")
    }
    validateSchedule(sched, principal)
    return {
      installmentAmount: sched[0],
      installmentCount: sched.length,
      schedule: sched,
    }
  }
  return buildScheduleFromTerms({
    mode: "FIXED",
    principalAmount: principal,
    installmentCount: input.installmentCount,
  })
}

export async function createEmployeeLoan(input: {
  employeeProfileId: string
  principalAmount: number
  mode: LoanRepaymentMode
  installmentCount?: number | null
  /// Per-month amounts — required for CUSTOM (each month can differ),
  /// ignored for FIXED (equal split is computed from installmentCount).
  schedule?: number[]
  startYear: number
  startMonth: number
  notes: string | null
}): Promise<EmployeeLoanData> {
  const ctx = await requireAdminOrg()
  if (!ctx) throw new Error("Session expired. Please log in again.")

  const employees = await payrollProfileRepository.listReadyForPayroll(ctx.orgId)
  const employee = employees.find(
    (e) => e.employeeProfileId === input.employeeProfileId,
  )
  if (!employee) {
    throw new Error("Employee not found in this organisation.")
  }
  assertValidStart(input.startYear, input.startMonth)

  const terms = resolveTerms({
    mode: input.mode,
    principalAmount: input.principalAmount,
    installmentCount: input.installmentCount,
    schedule: input.schedule,
  })

  const loan = await employeeLoanRepository.create({
    organizationId: ctx.orgId,
    employeeProfileId: input.employeeProfileId,
    principalAmount: Math.round(input.principalAmount * 100) / 100,
    mode: input.mode,
    installmentAmount: terms.installmentAmount,
    installmentCount: terms.installmentCount,
    schedule: terms.schedule,
    startYear: input.startYear,
    startMonth: input.startMonth,
    notes: input.notes,
  })

  await markAffectedDraftsMutated(ctx.orgId, {
    startYear: loan.startYear,
    startMonth: loan.startMonth,
    installmentCount: loan.installmentCount,
  })
  await bustPayrollCaches({ organizationId: ctx.orgId })
  return loan
}

/**
 * Edit a loan. The allowed scope depends on repayment progress:
 *   - Not started (no installment paid on a submitted run) → full edit:
 *     amount / mode / start / installments are rebuilt from scratch.
 *   - Started + FIXED → rejected (equal installments are immutable once
 *     repayment is underway).
 *   - Started + CUSTOM → only the not-yet-paid installments may change,
 *     and the whole schedule must still sum to the principal. Paid
 *     installments are locked to their existing amounts.
 *
 * `full` is used for the not-started path; `schedule` for the
 * started-custom path. The server re-derives the loan state and ignores
 * whichever payload doesn't apply.
 */
export async function editEmployeeLoan(input: {
  loanId: string
  full?: {
    principalAmount: number
    mode: LoanRepaymentMode
    installmentCount?: number | null
    installmentAmount?: number | null
    startYear: number
    startMonth: number
  }
  schedule?: number[]
  notes: string | null
}): Promise<void> {
  const ctx = await requireAdminOrg()
  if (!ctx) throw new Error("Session expired. Please log in again.")

  const loan = await employeeLoanRepository.getByIdForOrg({
    id: input.loanId,
    organizationId: ctx.orgId,
  })
  if (!loan) throw new Error("Loan not found.")
  if (loan.status === "CANCELLED") {
    throw new Error("This loan is cancelled and can no longer be edited.")
  }

  const submittedPeriods = await payrollRunRepository.listSubmittedPeriods(ctx.orgId)
  const breakdown = loanInstallmentBreakdown(loan, submittedPeriods)
  const hasStarted = breakdown.some((b) => b.paid)

  if (!hasStarted) {
    // Full rebuild from terms. CUSTOM uses the explicit per-month
    // schedule; FIXED uses an equal split from the installment count.
    const full = input.full
    if (!full) throw new Error("Missing loan details.")
    assertValidStart(full.startYear, full.startMonth)
    const terms = resolveTerms({
      mode: full.mode,
      principalAmount: full.principalAmount,
      installmentCount: full.installmentCount,
      schedule: input.schedule,
    })
    await employeeLoanRepository.update({
      id: loan.id,
      organizationId: ctx.orgId,
      principalAmount: Math.round(full.principalAmount * 100) / 100,
      mode: full.mode,
      installmentAmount: terms.installmentAmount,
      installmentCount: terms.installmentCount,
      schedule: terms.schedule,
      startYear: full.startYear,
      startMonth: full.startMonth,
      notes: input.notes,
    })
    // Flag drafts in both the old and the new window (start month may
    // have changed) so stale payslips get re-run before submission.
    await markAffectedDraftsMutated(ctx.orgId, loan)
    await markAffectedDraftsMutated(ctx.orgId, {
      startYear: full.startYear,
      startMonth: full.startMonth,
      installmentCount: terms.installmentCount,
    })
    await bustPayrollCaches({ organizationId: ctx.orgId })
    return
  }

  // Repayment underway.
  if (loan.mode === "FIXED") {
    throw new Error(
      "Repayment has already started — a fixed-installment loan can't be edited.",
    )
  }
  // CUSTOM, started: accept a new schedule but keep paid installments
  // unchanged and the total equal to the principal.
  const next = input.schedule
  if (!next) throw new Error("Missing installment schedule.")
  // Paid installments are locked: the new schedule must reproduce each
  // paid installment's amount at the same index.
  for (const paid of breakdown.filter((b) => b.paid)) {
    const proposed = next[paid.index]
    if (proposed == null || Math.abs(proposed - paid.amount) > 0.01) {
      throw new Error(
        "Already-paid installments can't be changed. Only future installments are editable.",
      )
    }
  }
  validateSchedule(next, loan.principalAmount)

  await employeeLoanRepository.update({
    id: loan.id,
    organizationId: ctx.orgId,
    principalAmount: loan.principalAmount,
    mode: "CUSTOM",
    installmentAmount: next[0] ?? loan.installmentAmount,
    installmentCount: next.length,
    schedule: next.map((n) => Math.round(n * 100) / 100),
    startYear: loan.startYear,
    startMonth: loan.startMonth,
    notes: input.notes,
  })
  await markAffectedDraftsMutated(ctx.orgId, {
    startYear: loan.startYear,
    startMonth: loan.startMonth,
    installmentCount: next.length,
  })
  await bustPayrollCaches({ organizationId: ctx.orgId })
}

export async function cancelEmployeeLoan(loanId: string): Promise<void> {
  const ctx = await requireAdminOrg()
  if (!ctx) throw new Error("Session expired. Please log in again.")
  // Capture the window before cancelling so we can flag drafts that
  // were relying on this loan's installment.
  const loan = await employeeLoanRepository.getByIdForOrg({
    id: loanId,
    organizationId: ctx.orgId,
  })
  await employeeLoanRepository.setStatus({
    id: loanId,
    organizationId: ctx.orgId,
    status: "CANCELLED",
  })
  if (loan) {
    await markAffectedDraftsMutated(ctx.orgId, {
      startYear: loan.startYear,
      startMonth: loan.startMonth,
      installmentCount: loan.installmentCount,
    })
  }
  await bustPayrollCaches({ organizationId: ctx.orgId })
}
