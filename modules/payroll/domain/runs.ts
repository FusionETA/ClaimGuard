/**
 * Domain types for `PayrollRun` and `Payslip` aggregates.
 *
 * Phase 3 scope: we model the run + a list-row shape. Payslip details
 * (line items, employee snapshots) ship in Phase 4 alongside the
 * calculation engine. This file deliberately keeps Payslip stubs
 * minimal so the run-shell UI compiles without depending on the
 * full payslip projection.
 */

// ─── Enums ───────────────────────────────────────────────────────────────

export const payrollRunStatuses = ["DRAFT", "SUBMITTED"] as const
export type PayrollRunStatus = (typeof payrollRunStatuses)[number]

export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
}

// ─── PayrollRun ──────────────────────────────────────────────────────────

/**
 * Full PayrollRun projection. Totals are nullable while DRAFT (they get
 * filled in when the run is finalised). Decimal values are coerced to
 * JS numbers via `toNumber()` in the repo.
 */
export type PayrollRunData = {
  id: string
  organizationId: string

  periodYear: number
  /// 1..12
  periodMonth: number
  status: PayrollRunStatus

  // Cached totals (null while DRAFT).
  totalGross: number | null
  totalNet: number | null
  totalEmployeeEpf: number | null
  totalEmployerEpf: number | null
  totalEmployeeSocso: number | null
  totalEmployerSocso: number | null
  totalEmployeeEis: number | null
  totalEmployerEis: number | null
  totalPcb: number | null
  totalHrdf: number | null
  totalZakat: number | null
  totalCostToEmployer: number | null
  employeeCount: number | null
  employeesSubjectToHrdf: number | null
  totalWagesSubjectToHrdf: number | null

  submittedAt: string | null
  submittedById: string | null

  createdAt: string
  updatedAt: string
}

/**
 * Row shape for the runs list page. Adds a pre-computed payslip count
 * so the list can render "12 employees" without fetching the full
 * Payslip[] relation.
 */
export type PayrollRunRow = PayrollRunData & {
  payslipCount: number
}

// ─── Payslip ─────────────────────────────────────────────────────────────

export const payslipLineKinds = [
  "ALLOWANCE",
  "DEDUCTION",
  "REIMBURSEMENT",
] as const
export type PayslipLineKind = (typeof payslipLineKinds)[number]

/**
 * Single line item on a payslip. Maps 1:1 with the
 * `PayslipLineItem` Prisma model.
 */
export type PayslipLineItemData = {
  id: string
  payslipId: string
  kind: PayslipLineKind
  label: string
  amount: number
  claimId: string | null
  subjectToEpf: boolean
  subjectToSocso: boolean
  subjectToEis: boolean
  subjectToPcb: boolean
  createdAt: string
}

/**
 * Snapshot of EPF rates stored on the payslip for audit. Mirrors the
 * JSON shape written by the calc engine.
 */
export type PayslipEpfRatesSnapshot = {
  employee: number
  employer: number
  voluntaryEmployee: number
  voluntaryEmployer: number
}

/**
 * Full Payslip projection. All Decimal columns coerced to numbers.
 */
export type PayslipData = {
  id: string
  payrollRunId: string
  employeeProfileId: string
  payrollProfileId: string | null

  // Snapshots (frozen at generation)
  snapshotName: string
  snapshotEmployeeId: string
  snapshotPosition: string | null
  snapshotSalaryType: "MONTHLY" | "HOURLY"
  snapshotMonthlySalary: number | null
  snapshotHourlyRate: number | null
  snapshotNationality: string | null
  snapshotIsResident: boolean
  snapshotEpfRates: PayslipEpfRatesSnapshot

  // Computed
  basicPay: number
  proratedPay: number
  workedHours: number | null
  proratedFactor: number
  proratedDays: number | null
  totalWorkingDays: number | null

  // OT
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  otPay: number

  // Aggregates
  totalAllowances: number
  totalReimbursements: number
  totalDeductions: number
  unpaidLeaveDeduction: number

  // Statutory
  epfEmployee: number
  epfEmployer: number
  socsoEmployee: number
  socsoEmployer: number
  eisEmployee: number
  eisEmployer: number
  pcb: number
  hrdf: number
  zakat: number
  hrdfWage: number

  // Totals
  grossPay: number
  netPay: number
  totalCostToEmployer: number

  createdAt: string
  updatedAt: string

  lineItems: PayslipLineItemData[]
}

/**
 * Row shape for the payslips list on the run detail page. Same as
 * PayslipData minus the line items (loaded lazily on the detail page).
 */
export type PayslipRow = Omit<PayslipData, "lineItems"> & {
  lineItemCount: number
}

// ─── PayrollRunClaim (Phase 5) ───────────────────────────────────────────

/**
 * Projection of a `PayrollRunClaim` join row plus everything the run
 * detail page needs to render the "Reimbursements" section without
 * extra queries.
 */
export type PayrollRunClaimRow = {
  id: string
  payrollRunId: string
  claimId: string
  employeeProfileId: string
  /// User.id (so links jump to /admin/payroll/employees/[userId]).
  userId: string
  /// Snapshotted at attach time
  label: string
  amount: number
  // Joined fields for UX
  employeeName: string
  employeeCode: string
  /// Original claim metadata for the row (read-only).
  claimNumber: string
  claimCategory: string
  claimType: "EXPENSE" | "MILEAGE"
  createdAt: string
}

/**
 * Lighter shape used inside the calc engine — no joined identity
 * fields, just what the engine needs to build a REIMBURSEMENT line.
 */
export type PayrollRunClaimForCalc = {
  claimId: string
  employeeProfileId: string
  label: string
  amount: number
}

// ─── PayrollRunAdjustment (Phase 7) ──────────────────────────────────────

export const manualLineItemKinds = ["ALLOWANCE", "DEDUCTION"] as const
export type ManualLineItemKind = (typeof manualLineItemKinds)[number]

/**
 * One-off allowance/deduction applied to a single payroll run for a
 * single employee. Distinct from the recurring `FixedAllowance` on
 * `PayrollProfile`, which auto-applies to every run.
 */
export type ManualLineItem = {
  kind: ManualLineItemKind
  label: string
  amount: number
}

/**
 * Full PayrollRunAdjustment projection. Returned by the repo with
 * Decimals already coerced and JSON parsed.
 */
export type PayrollRunAdjustmentData = {
  id: string
  payrollRunId: string
  employeeProfileId: string
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  manualLineItems: ManualLineItem[]
  unpaidLeaveDeduction: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A SYNCED, PERSONAL-payment-type claim that is eligible to be
 * attached to a payroll run. Used by the run detail page to render
 * the "Available claims" pickable list.
 */
export type AttachableClaimRow = {
  claimId: string
  claimNumber: string
  title: string
  category: string
  claimType: "EXPENSE" | "MILEAGE"
  amount: number
  spentAt: string
  employeeProfileId: string
  /// User.id of the claim submitter (used for jump links).
  userId: string
  employeeName: string
  employeeCode: string
  /// True when the claim is already attached to a run — UI greys it
  /// out and shows where it's attached.
  attachedToRunId: string | null
  attachedToRunPeriod: string | null // human label e.g. "January 2026"
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

/**
 * Render a (year, month 1-12) pair as a human label, e.g.
 * `periodLabel(2026, 1) → "January 2026"`. Pure — safe to use on the
 * client.
 */
export function periodLabel(year: number, month: number): string {
  const m = MONTH_NAMES[(month - 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11]
  if (!m) return `${year}-${String(month).padStart(2, "0")}`
  return `${m} ${year}`
}

/**
 * "YYYY-MM" sort key — used to order runs chronologically without
 * pulling in a date library.
 */
export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`
}

/**
 * Default the period picker to the current month. Returns
 * `{ year, month }` in the server timezone.
 */
export function currentPeriod(now: Date = new Date()): {
  year: number
  month: number
} {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
}
