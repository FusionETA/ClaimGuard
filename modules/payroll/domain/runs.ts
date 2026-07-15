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

export const payrollRunStatuses = [
  "DRAFT",
  "PENDING_APPROVAL",
  "SUBMITTED",
] as const
export type PayrollRunStatus = (typeof payrollRunStatuses)[number]

export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Awaiting approval",
  SUBMITTED: "Submitted",
}

export const payrollRunSources = ["COMPUTED", "IMPORTED"] as const
export type PayrollRunSource = (typeof payrollRunSources)[number]

export const PAYROLL_RUN_SOURCE_LABELS: Record<PayrollRunSource, string> = {
  COMPUTED: "Computed",
  IMPORTED: "Imported",
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
  /// Where the run originated. COMPUTED = engine; IMPORTED = seeded
  /// from a YTD migration upload. Drives audit grouping on the runs
  /// list page.
  source: PayrollRunSource

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
  /// When the run entered PENDING_APPROVAL. Null while still DRAFT
  /// (or has never been submitted for approval).
  submittedForApprovalAt: string | null
  submittedForApprovalById: string | null
  /// Optional reason captured when an approver sends a pending run
  /// back to DRAFT. Stays on the run for audit + is shown to the
  /// original submitter so they know why their submission bounced.
  approvalRejectionReason: string | null

  createdAt: string
  updatedAt: string
  /// Set on every content mutation (claim attach/detach, adjustment
  /// save/clear), CLEARED when payroll is generated. Null means "no
  /// pending mutations" — Submit is safe. When non-null and newer
  /// than the latest `Payslip.createdAt`, the run is stale and the
  /// UI prompts the admin to re-run. NOT touched by status changes
  /// (submit / revert).
  lastMutatedAt: string | null

  // ── Xero sync ──────────────────────────────────────────────────────
  /// Xero ManualJournalID set when the run was successfully posted.
  /// Null until then. Surface on the run page as "Posted to Xero".
  xeroManualJournalId: string | null
  /// Friendly journal narration echoed back from Xero.
  xeroJournalNumber: string | null
  /// Per-run sync state. NOT_SYNCED until first attempt; SYNCED on
  /// success; ERROR on failure (the run page renders a retry button
  /// when this is ERROR).
  xeroSyncStatus: "NOT_SYNCED" | "SYNCED" | "ERROR"
  xeroSyncError: string | null
  xeroSyncedAt: string | null

  /// Employee-policy ids this run was scoped to at creation time.
  /// `null` = no scope = org-wide (legacy). When non-null, payslip
  /// generation only pulls employees whose `EmployeeProfile.policyId`
  /// is in this list. Picked from the "Create draft" dialog (a
  /// restricted admin sees only their granted policies).
  policyIds: string[] | null
  /// EmployeeProfile ids to EXCLUDE from this run — layered on top of
  /// `policyIds`. `null` or empty = no per-employee exclusions.
  /// Frozen at create time; changing membership after create requires
  /// deleting the draft and starting over.
  excludedEmployeeProfileIds: string[] | null
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
  /// PCB-taxable portion of `amount` — after applying any per-item
  /// LHDN `taxExemptLimit` at write time. Null when no clamp applied
  /// (use `amount` as-is) or on legacy rows written before this
  /// column existed.
  pcbTaxableAmount: number | null
  /// `PayrollAdjustmentCategory` code (when known). Nullable on
  /// legacy rows written before the column existed, and on free-form
  /// manual deductions / claim reimbursements that don't tie back to
  /// a category in `PAYROLL_ADJUSTMENT_CATEGORY_META`.
  category: string | null
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
 *
 * The rate fields (`employee` / `employer` / `voluntary*`) are the
 * percentages that applied to this run. The amount fields (`*Amount`)
 * are the RM contribution split into mandatory vs voluntary on each
 * side, so the Detailed Calculations PDF can render them as separate
 * lines without redoing the math. Without these the PDF showed a
 * single line per side labelled with just the mandatory rate, even
 * when the amount silently included voluntary on top — which read as
 * "voluntary not applied" to anyone who did the back-of-napkin check.
 *
 * Amount fields are optional for backward compatibility — historical
 * payslips written before this change omit them. The parser defaults
 * to 0 in that case; renderers should fall back to a single combined
 * line when the amounts are missing AND voluntary % > 0.
 */
export type PayslipEpfRatesSnapshot = {
  employee: number
  employer: number
  voluntaryEmployee: number
  voluntaryEmployer: number
  mandatoryAmountEmployee?: number
  mandatoryAmountEmployer?: number
  voluntaryAmountEmployee?: number
  voluntaryAmountEmployer?: number
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
  expectedHours: number | null
  /// Approved UNPAID leave days in the period (display-only; drives the
  /// DAYS column: actual working days = totalWorkingDays − unpaidLeaveDays).
  unpaidLeaveDays: number | null
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
  /// Non-cash benefits (BIK / perquisites) — disclosed separately
  /// from gross. May be 0. See calc.ts for the split rationale.
  totalBenefitsInKind: number
  totalReimbursements: number
  totalDeductions: number

  // Statutory
  epfEmployee: number
  epfEmployer: number
  socsoEmployee: number
  socsoEmployer: number
  eisEmployee: number
  eisEmployer: number
  /// SKBBK (Skim LINDUNG 24 Jam) — employee-only contribution
  /// effective 1 Jun 2026. 0 on historical payslips written before
  /// the schema migration landed; renderers should coalesce to 0.
  skbbkEmployee: number
  /// Wage base used for the SKBBK lookup. Equals socso wage in
  /// current code; persisted separately so historical payslips
  /// remain interpretable if PERKESO ever decouples them.
  skbbkWage: number
  /// Snapshot of the employee's SKBBK opt-in decision at time of run.
  /// Frozen so a re-edit of a submitted run for an unrelated reason
  /// (bonus, claim correction) never silently unwinds an already-
  /// remitted SKBBK line. Defaults false on rows written before the
  /// snapshot column existed.
  contributeToSkbbk: boolean
  pcb: number
  /// CP38 arrears (LHDN court order) — kept separate from `pcb` per
  /// LHDN MTD Spec 2026 page 14 X-definition. 0 when no `deduct_cp38`
  /// line item was on the payslip.
  cp38: number
  /// LHDN-style PCB formula breakdown — see `CalcPcbBreakdown` in
  /// `modules/payroll/domain/pcb.ts`. Null on payslips generated before
  /// the snapshot column existed; consumers should fall back to the
  /// flat `pcb` number for display in that case.
  pcbCalculation: unknown
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
 * PayslipData plus a denormalised line-item count so the UI can
 * render badges or summaries without counting in the client.
 *
 * Line items are eagerly loaded with the list because the admin
 * table renders the earnings breakdown inline under each employee
 * name (matching the printable Payroll Summary PDF). For a typical
 * run of 10–100 employees this adds a few KB of payload and saves
 * the 50+ lazy-load round-trips the previous expand-row design
 * required.
 */
export type PayslipRow = PayslipData & {
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

// REIMBURSEMENT-kind manual line items represent ad-hoc expense claims
// that aren't backed by a Claim record in the Claims module. The main
// use case is historical payroll imports — when migrating from another
// payroll system (e.g. Payroll Panda), a past run may have paid out
// claims that aren't in AltomateHR's Claims table. The admin records
// them here as REIMBURSEMENT line items so the historical payslip
// totals match.
//
// Statutory treatment: same as live claims — feeds gross pay, NOT
// subject to EPF / SOCSO / EIS / PCB / HRDF. The `wages_expense_claim`
// category carries the right `subjectTo*: false` flags.
export const manualLineItemKinds = [
  "ALLOWANCE",
  "DEDUCTION",
  "REIMBURSEMENT",
] as const
export type ManualLineItemKind = (typeof manualLineItemKinds)[number]

/**
 * One-off allowance/deduction applied to a single payroll run for a
 * single employee. Distinct from the recurring `FixedAllowance` on
 * `PayrollProfile`, which auto-applies to every run.
 *
 * `category` controls statutory treatment (EPF / SOCSO / EIS / PCB)
 * via `PAYROLL_ADJUSTMENT_CATEGORY_META`. Stored as a string here so
 * the domain types stay free of circular imports — repos validate the
 * value on read.
 */
export type ManualLineItem = {
  kind: ManualLineItemKind
  /// PayrollAdjustmentCategory code (see `modules/payroll/domain/models.ts`).
  /// Defaulted to `allowance_standard` / `deduct_salary_adjustment` for
  /// legacy rows persisted before Phase 19.
  category: string
  label: string
  amount: number
  /// LHDN Additional Remuneration override.
  ///
  /// When the chosen category has `isAdditionalRemuneration: true`
  /// (bonus / commission / arrears / gratuity / director-fee), the
  /// default PCB path treats the amount as a one-off — annual tax is
  /// re-projected with the bonus layered on, and the marginal tax
  /// becomes this month's PCB. That's the right default for a true
  /// one-shot bonus.
  ///
  /// Some employees receive an AR-flagged category EVERY month
  /// (monthly commission, monthly director fee). In that case the
  /// AR formula causes PCB to swing wildly. Setting this flag to
  /// `true` routes the amount into the NORMAL recurring bucket
  /// instead — annualised by × (n+1), spread across the year, smooth
  /// monthly PCB.
  ///
  /// Defaults to `false` (= AR formula). Has no effect on categories
  /// where `meta.isAdditionalRemuneration` is `false` (those always
  /// use the normal bucket anyway).
  treatAsRecurring?: boolean
  /// Optional backlink to the LeaveEntitlement row this line item
  /// was derived from. Set ONLY when category === "wages_leave_pay"
  /// and the attach came from the Expired-leave-cash-out card on the
  /// run page. Lets the detach action find + remove the line item
  /// without label matching, and lets the cash-out card know which
  /// rows are already attached. Other manual line items leave this
  /// undefined.
  sourceEntitlementId?: string
}

/**
 * Per-run override for a single row in `PayrollProfile.fixedAllowances`.
 * Keyed by the profile's fixed-allowance index (as a string in the JSON
 * column so it round-trips cleanly). When `skip` is true the row is
 * zeroed for this run. When `amount` is a number it replaces the
 * profile amount — the original `category` / `name` are preserved so
 * statutory treatment (EPF/SOCSO/EIS/PCB) follows through.
 */
export type FixedAllowanceOverride = {
  /// Override amount for this run only. `null` = use the profile amount.
  amount: number | null
  /// True = zero this row out for this run only.
  skip: boolean
}

/**
 * Map of `fixed-allowance index` → override. Sparse — only modified
 * rows appear. Built by `parseFixedAllowanceOverrides` from the JSON
 * column.
 */
export type FixedAllowanceOverrideMap = Record<string, FixedAllowanceOverride>

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
  /// Per-run override of the auto-computed regular working hours. Null =
  /// use the value derived from attendance + paid leave at calc time.
  /// MONTHLY: `workedHours / expectedHours` drives the HRS % proration.
  /// HOURLY: `workedHours` is the paid quantity (`expectedHours` unused).
  workedHours: number | null
  expectedHours: number | null
  manualLineItems: ManualLineItem[]
  fixedAllowanceOverrides: FixedAllowanceOverrideMap
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
