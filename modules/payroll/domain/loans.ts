/**
 * Staff-loan / cash-advance domain helpers — pure functions, no I/O.
 *
 * A loan is repaid via an automatic monthly DEDUCTION line item on each
 * payroll run inside a fixed window. The window starts at
 * (`startYear`, `startMonth`) and runs for `installmentCount`
 * consecutive months. Repayment progress (paid / remaining) is derived
 * from the SUBMITTED runs whose period falls inside that window — we
 * never store a running balance, so re-opening/regenerating a run can't
 * desync it.
 *
 * Each loan carries an explicit per-installment `schedule` (number[],
 * one amount per month). This lets:
 *   - FIXED loans use equal installments (last absorbs the remainder),
 *   - CUSTOM loans carry uneven installments, and
 *   - the admin edit not-yet-paid installments later, as long as the
 *     whole schedule still sums to the principal.
 * Legacy rows without a stored schedule fall back to an equal-split
 * derived from `installmentAmount` / `installmentCount`.
 */

export type LoanRepaymentMode = "FIXED" | "CUSTOM"
export type LoanStatus = "ACTIVE" | "COMPLETED" | "CANCELLED"

export type EmployeeLoanData = {
  id: string
  employeeProfileId: string
  employeeName?: string
  employeeCode?: string
  principalAmount: number
  mode: LoanRepaymentMode
  installmentAmount: number
  startYear: number
  startMonth: number
  installmentCount: number
  /// Per-installment amounts, length === installmentCount.
  schedule: number[]
  status: LoanStatus
  notes: string | null
  createdAt: string
}

export type LoanPeriod = { year: number; month: number }

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/** Zero-based index of (year, month) relative to the loan's start. */
function periodIndex(
  loan: Pick<EmployeeLoanData, "startYear" | "startMonth">,
  year: number,
  month: number,
): number {
  return (year - loan.startYear) * 12 + (month - loan.startMonth)
}

/** The (year, month) of installment index `idx` (0-based) from start. */
export function periodAtIndex(
  loan: Pick<EmployeeLoanData, "startYear" | "startMonth">,
  idx: number,
): LoanPeriod {
  const raw = loan.startMonth - 1 + idx
  const year = loan.startYear + Math.floor(raw / 12)
  const month = (raw % 12) + 1
  return { year, month }
}

/** The last period the loan deducts on (inclusive). */
export function loanEndPeriod(
  loan: Pick<EmployeeLoanData, "startYear" | "startMonth" | "installmentCount">,
): LoanPeriod {
  return periodAtIndex(loan, loan.installmentCount - 1)
}

/** Build an equal-installment schedule (last absorbs the remainder). */
export function buildEqualSchedule(
  principal: number,
  installmentAmount: number,
  installmentCount: number,
): number[] {
  const out: number[] = []
  for (let i = 0; i < installmentCount; i++) {
    if (i === installmentCount - 1) {
      out.push(Math.max(0, round2(principal - installmentAmount * (installmentCount - 1))))
    } else {
      out.push(round2(installmentAmount))
    }
  }
  return out
}

/** The effective schedule for a loan — stored one, or an equal split. */
export function resolveSchedule(loan: EmployeeLoanData): number[] {
  if (
    Array.isArray(loan.schedule) &&
    loan.schedule.length === loan.installmentCount &&
    loan.schedule.every((n) => Number.isFinite(n))
  ) {
    return loan.schedule.map(round2)
  }
  return buildEqualSchedule(
    loan.principalAmount,
    loan.installmentAmount,
    loan.installmentCount,
  )
}

/**
 * The deduction amount due for this loan in the given payroll period.
 * Returns 0 when the loan isn't ACTIVE or the period is outside the
 * repayment window.
 */
export function loanInstallmentForPeriod(
  loan: EmployeeLoanData,
  year: number,
  month: number,
): number {
  if (loan.status !== "ACTIVE") return 0
  if (loan.installmentCount <= 0 || loan.principalAmount <= 0) return 0
  const idx = periodIndex(loan, year, month)
  if (idx < 0 || idx >= loan.installmentCount) return 0
  return round2(resolveSchedule(loan)[idx] ?? 0)
}

export type LoanInstallment = {
  index: number
  year: number
  month: number
  amount: number
  paid: boolean
}

/** Per-installment breakdown with paid/unpaid flags from submitted runs. */
export function loanInstallmentBreakdown(
  loan: EmployeeLoanData,
  submittedPeriods: LoanPeriod[],
): LoanInstallment[] {
  const sched = resolveSchedule(loan)
  const submittedKeys = new Set(
    submittedPeriods.map((p) => `${p.year}-${p.month}`),
  )
  return sched.map((amount, idx) => {
    const { year, month } = periodAtIndex(loan, idx)
    return {
      index: idx,
      year,
      month,
      amount: round2(amount),
      paid: submittedKeys.has(`${year}-${month}`),
    }
  })
}

export type LoanScheduleSummary = {
  totalInstallments: number
  paidInstallments: number
  paidAmount: number
  remainingAmount: number
  endYear: number
  endMonth: number
  fullyRepaid: boolean
  /// True once at least one installment period has a SUBMITTED run.
  hasStarted: boolean
}

export function loanScheduleSummary(
  loan: EmployeeLoanData,
  submittedPeriods: LoanPeriod[],
): LoanScheduleSummary {
  const breakdown = loanInstallmentBreakdown(loan, submittedPeriods)
  const paid = breakdown.filter((b) => b.paid)
  const paidAmount = round2(paid.reduce((s, b) => s + b.amount, 0))
  const end = loanEndPeriod(loan)
  return {
    totalInstallments: loan.installmentCount,
    paidInstallments: paid.length,
    paidAmount,
    remainingAmount: Math.max(0, round2(loan.principalAmount - paidAmount)),
    endYear: end.year,
    endMonth: end.month,
    fullyRepaid: paid.length >= loan.installmentCount,
    hasStarted: paid.length > 0,
  }
}

/**
 * Resolve installment amount + count from the admin's create inputs.
 *   - FIXED  → caller supplies `installmentCount`; amount = principal/count.
 *   - CUSTOM → caller supplies `installmentAmount`; count = ceil(principal/amount).
 */
export function computeLoanTerms(input: {
  mode: LoanRepaymentMode
  principalAmount: number
  installmentCount?: number | null
  installmentAmount?: number | null
}): { installmentAmount: number; installmentCount: number } {
  const principal = round2(input.principalAmount)
  if (!(principal > 0)) {
    throw new Error("Loan amount must be greater than zero.")
  }
  if (input.mode === "FIXED") {
    const count = Math.trunc(input.installmentCount ?? 0)
    if (!(count > 0)) {
      throw new Error("Number of installments must be at least 1.")
    }
    return { installmentAmount: round2(principal / count), installmentCount: count }
  }
  const amount = round2(input.installmentAmount ?? 0)
  if (!(amount > 0)) {
    throw new Error("Monthly repayment amount must be greater than zero.")
  }
  if (amount > principal) {
    return { installmentAmount: principal, installmentCount: 1 }
  }
  const count = Math.ceil(principal / amount)
  return { installmentAmount: amount, installmentCount: count }
}

/** Full create-time terms incl. the generated equal-split schedule. */
export function buildScheduleFromTerms(input: {
  mode: LoanRepaymentMode
  principalAmount: number
  installmentCount?: number | null
  installmentAmount?: number | null
}): { installmentAmount: number; installmentCount: number; schedule: number[] } {
  const terms = computeLoanTerms(input)
  return {
    ...terms,
    schedule: buildEqualSchedule(
      round2(input.principalAmount),
      terms.installmentAmount,
      terms.installmentCount,
    ),
  }
}

/**
 * Validate an edited schedule: every installment positive and the total
 * equals the principal (to the cent). Throws a clean message otherwise.
 */
export function validateSchedule(schedule: number[], principal: number): void {
  if (schedule.length === 0) {
    throw new Error("A loan needs at least one installment.")
  }
  if (schedule.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error("Every installment must be greater than zero.")
  }
  const total = round2(schedule.reduce((s, n) => s + n, 0))
  if (Math.abs(total - round2(principal)) > 0.01) {
    throw new Error(
      `Installments must add up to the loan amount (${round2(
        principal,
      )}). Current total is ${total}.`,
    )
  }
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/** "Jan 2026" style label for a loan period. */
export function formatLoanPeriodLabel(year: number, month: number): string {
  return `${MONTH_LABELS[month - 1] ?? `M${month}`} ${year}`
}
