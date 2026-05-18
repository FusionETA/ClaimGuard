/**
 * Malaysian payroll calculation engine — pure functions, no Prisma, no
 * I/O. The orchestrator (`calcPayslip`) takes plain inputs and returns
 * the full set of payslip numbers that the repo persists.
 *
 * Scope: basic pay, OT, fixed adjustments, EPF (KWSP Third Schedule
 * Parts A/C/E/F), SOCSO (Act 4 stepped table, Cat 1 / Cat 2 with
 * RM 6,000 cap), EIS (Act 800 stepped table, age 18-60 gating),
 * HRDF (Malaysian-citizens-only per PSMB Act § 2 wage definition),
 * PCB (LHDN MTD Specification for 2026 — resident progressive +
 * non-resident flat 30%, with AR / YTD / threshold / rounding),
 * proration.
 *
 * Reference: Malaysian Employment Act, EPF Act 1991 Third Schedule,
 * Employees' Social Security Act 1969, EIS Act 2017, PSMB Act 2001,
 * LHDN MTD Specification 2026.
 */

import { PAYROLL_ADJUSTMENT_CATEGORY_META } from "@/modules/payroll/domain/models"
import type {
  FixedAllowance,
  PayrollProfileData,
  SalaryType,
  SocsoScheme,
} from "@/modules/payroll/domain/models"
import { calcPcb } from "@/modules/payroll/domain/pcb"
import type { WorkingDaysRule } from "@/modules/payroll/domain/settings"
import {
  lookupEis,
  lookupEpfBand,
  lookupSocso,
} from "@/modules/payroll/domain/statutory-tables"

// ─── Rounding ────────────────────────────────────────────────────────────

/** Round to 2 decimal places. Used for every currency output. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

// ─── EPF ─────────────────────────────────────────────────────────────────

/**
 * EPF branch selection per KWSP Third Schedule. The branch determines
 * the *mandatory* rate; voluntary contributions stack on top of
 * mandatory in all branches.
 *
 * Source: KWSP Contribution Rate table (Third Schedule Parts A / C /
 * E / F). The Oct 2025 amendment introduced the post-1998
 * non-Malaysian 2% / 2% rule (Part F).
 */
export type EpfBranch =
  | "MALAYSIAN_UNDER_60" // Citizen / PR / pre-1998 non-MY, < 60 → Part A
  | "MALAYSIAN_CITIZEN_60_PLUS" // Pure Malaysian citizen, ≥ 60 → Part E
  | "PR_OR_PRE1998_60_PLUS" // PR or pre-1998 non-MY, ≥ 60 → Part C
  | "POST_1998_NON_MALAYSIAN" // Non-MY registered ≥ 1 Aug 1998 → Part F
  | "DE_MINIMIS" // Wage ≤ RM 10 → 0/0
  | "OPTED_OUT" // contributeToEpf = false → 0/0

/**
 * Inputs for the EPF calc. Wider than the rate-only signature so we
 * can pick the correct KWSP Third Schedule branch.
 */
export type CalcEpfInput = {
  wage: number
  /// Employee mandatory rate %; the calc engine overrides this with
  /// the branch's statutory rate for non-Part-A branches (so the
  /// "11%" the admin enters has no effect at age 60+ or for post-1998
  /// foreign workers).
  employeeRate: number
  employeeVoluntary: number
  employerVoluntary: number
  contributeToEpf: boolean
  /// Branch flags — caller derives these from PayrollProfile +
  /// payroll period.
  isMalaysianCitizen: boolean
  hasPr: boolean
  /// True when the non-Malaysian employee was an EPF member before
  /// 1 August 1998 (drives Part A / C vs Part F).
  epfMemberBefore1998: boolean
  /// Age at the END of the payroll period (60+ flips into Part C / E).
  ageAtPeriodEnd: number
}

/**
 * Compute which KWSP Third Schedule branch applies to this employee
 * for this period. Pure decision tree — no I/O.
 */
export function pickEpfBranch(input: {
  contributeToEpf: boolean
  wage: number
  isMalaysianCitizen: boolean
  hasPr: boolean
  epfMemberBefore1998: boolean
  ageAtPeriodEnd: number
}): EpfBranch {
  if (!input.contributeToEpf) return "OPTED_OUT"
  if (input.wage <= 10) return "DE_MINIMIS"

  const isPartA_C_eligible =
    input.isMalaysianCitizen ||
    input.hasPr ||
    (!input.isMalaysianCitizen && !input.hasPr && input.epfMemberBefore1998)

  // Post-1998 non-Malaysian (not PR). Same rate any age, any wage.
  if (!isPartA_C_eligible) return "POST_1998_NON_MALAYSIAN"

  if (input.ageAtPeriodEnd < 60) return "MALAYSIAN_UNDER_60"

  // Age 60+: pure Malaysian citizens drop to Part E (0/4). PR + pre-
  // 1998 non-Malaysians stay on the tiered Part C (5.5 / 6.5 / 6).
  if (input.isMalaysianCitizen && !input.hasPr) {
    return "MALAYSIAN_CITIZEN_60_PLUS"
  }
  return "PR_OR_PRE1998_60_PLUS"
}

/**
 * EPF (Employees Provident Fund) contribution calc — KWSP Third
 * Schedule with all four branches:
 *
 *   - Part A (< 60): employer 13% (≤RM5K) / 12%, employee 11%
 *   - Part C (PR or pre-1998 non-MY, ≥ 60): employer 6.5% / 6%,
 *     employee 5.5%
 *   - Part E (Malaysian citizen ≥ 60): employer 4%, employee 0%
 *   - Part F (post-1998 non-MY, any age): employer 2%, employee 2%
 *
 * Voluntary contributions stack on top of all branches.
 */
export function calcEpf(input: CalcEpfInput): {
  employee: number
  employer: number
  branch: EpfBranch
} {
  const branch = pickEpfBranch({
    contributeToEpf: input.contributeToEpf,
    wage: input.wage,
    isMalaysianCitizen: input.isMalaysianCitizen,
    hasPr: input.hasPr,
    epfMemberBefore1998: input.epfMemberBefore1998,
    ageAtPeriodEnd: input.ageAtPeriodEnd,
  })

  if (branch === "OPTED_OUT" || branch === "DE_MINIMIS") {
    return { employee: 0, employer: 0, branch }
  }

  // KWSP rate parameters per Third Schedule branch.
  //
  // KWSP Third Schedule Note 2 mandates that for wages ≤ RM 20,000
  // employers MUST use the official Schedule TABLE (stepped, in
  // RM 20 / RM 100 bands, each side rounded up to the next ringgit)
  // rather than the exact percentage. `lookupEpfBand` reproduces the
  // gazetted table row-for-row from the rate inputs. Above RM 20,000
  // exact percentage is allowed (still rounded up to next ringgit).
  let employerRateLow: number
  let employerRateHigh: number
  let employeeRate: number
  switch (branch) {
    case "MALAYSIAN_UNDER_60":
      // Statutory minimum employee share is 11% per KWSP Third
      // Schedule Part A. The COVID-era 9% election ended; the
      // current KWSP 17A i-TOPUP form only allows employees to
      // contribute ABOVE the statutory rate, not below. We clamp
      // the admin's declared rate to a minimum of 11%. (Higher
      // voluntary rates belong in `epfEmployeeVoluntary`, not in
      // the base rate.)
      employeeRate = Math.max(11, input.employeeRate)
      employerRateLow = 13
      employerRateHigh = 12
      break
    case "MALAYSIAN_CITIZEN_60_PLUS":
      // Part E — flat 4% employer, 0% employee.
      employeeRate = 0
      employerRateLow = 4
      employerRateHigh = 4
      break
    case "PR_OR_PRE1998_60_PLUS":
      // Part C.
      employeeRate = 5.5
      employerRateLow = 6.5
      employerRateHigh = 6
      break
    case "POST_1998_NON_MALAYSIAN":
      // Part F — flat 2%/2% effective Oct 2025 salary.
      employeeRate = 2
      employerRateLow = 2
      employerRateHigh = 2
      break
  }

  const mandatory = lookupEpfBand({
    wage: input.wage,
    employerRateLow,
    employerRateHigh,
    employeeRate,
  })

  // Voluntary contributions stack on top. These use the exact
  // percentage (not the table) because they're not part of the
  // statutory minimum that the gazetted Schedule prescribes.
  const employeeExtra = round2(input.wage * (input.employeeVoluntary / 100))
  const employerExtra = round2(input.wage * (input.employerVoluntary / 100))
  return {
    employee: round2(mandatory.employee + employeeExtra),
    employer: round2(mandatory.employer + employerExtra),
    branch,
  }
}

// ─── SOCSO ───────────────────────────────────────────────────────────────

/**
 * SOCSO (Social Security Organisation) contribution per Act 4 Third
 * Schedule. Two schemes:
 *
 *   - Employment Injury + Invalidity (Cat 1, < age 60): employer +
 *     employee contribute (~1.75% / 0.5% as a rate-of-thumb, but the
 *     gazetted table is stepped, not pure percentage).
 *   - Employment Injury only (Cat 2, ≥ age 60 or foreign worker):
 *     employer only.
 *
 * The Third Schedule is a 65-row stepped lookup table; wages above
 * RM 6,000 are capped at the ceiling row. We use the gazetted table
 * directly via `lookupSocso` rather than the percentage formula.
 */
export function calcSocso(input: {
  wage: number
  scheme: SocsoScheme | null
}): { employee: number; employer: number } {
  if (!input.scheme) return { employee: 0, employer: 0 }
  const category2 = input.scheme === "EMPLOYMENT_INJURY_ONLY"
  return lookupSocso(input.wage, category2)
}

// ─── EIS ─────────────────────────────────────────────────────────────────

/**
 * EIS (Employment Insurance System) contribution per Act 800 Third
 * Schedule. ~0.2% each side, but gazetted as a 65-row stepped table
 * (similar shape to SOCSO). The ceiling row applies to wages above
 * RM 6,000.
 *
 * Eligibility (Malaysian citizen / PR / temporary resident, age
 * 18–60) is gated by the orchestrator before this is called — see
 * `calcPayslip` for the age + scope check.
 */
export function calcEis(input: {
  wage: number
  contributeToEis: boolean
}): { employee: number; employer: number } {
  if (!input.contributeToEis) return { employee: 0, employer: 0 }
  return lookupEis(input.wage)
}

// ─── Proration ───────────────────────────────────────────────────────────

/**
 * Days in the (year, month 1-12) calendar month. Pure helper — no
 * Date library dependency.
 */
export function calendarDaysInMonth(year: number, month: number): number {
  // Day 0 of next month → last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Working-days basis depending on the org's setting.
 *
 *   - CALENDAR    → actual calendar days in the month (28-31)
 *   - TWENTY_SIX  → fixed 26-day Malaysian convention
 */
export function workingDaysForPeriod(input: {
  year: number
  month: number
  rule: WorkingDaysRule
}): number {
  if (input.rule === "TWENTY_SIX") return 26
  return calendarDaysInMonth(input.year, input.month)
}

/**
 * Decide how many days of the period the employee should be paid for,
 * given join/leave dates. Returns null when the employee should NOT be
 * on this run at all (joined after the period ended, or left before it
 * started).
 *
 *   - Worked the full month     → returns workingDays (full month)
 *   - Joined mid-month          → returns days from joinDate to end of month
 *   - Left mid-month            → returns days from start of month to leaveDate
 *   - Joined AND left this month → returns days from joinDate to leaveDate
 */
export function effectiveWorkedDays(input: {
  periodYear: number
  periodMonth: number
  joinDate: string | null
  leaveDate: string | null
  workingDays: number
}): number | null {
  const periodStart = Date.UTC(input.periodYear, input.periodMonth - 1, 1)
  const periodEnd = Date.UTC(
    input.periodYear,
    input.periodMonth - 1,
    calendarDaysInMonth(input.periodYear, input.periodMonth),
  )

  const join = input.joinDate ? Date.parse(input.joinDate) : null
  const leave = input.leaveDate ? Date.parse(input.leaveDate) : null

  if (join != null && join > periodEnd) return null
  if (leave != null && leave < periodStart) return null

  const fullMonth =
    (join == null || join <= periodStart) &&
    (leave == null || leave >= periodEnd)
  if (fullMonth) return input.workingDays

  const startMs = join != null && join > periodStart ? join : periodStart
  const endMs = leave != null && leave < periodEnd ? leave : periodEnd

  // Inclusive day count.
  const days = Math.round((endMs - startMs) / 86_400_000) + 1
  // Cap the worked-days at the working-days basis (e.g. 26) so a
  // calendar-day count doesn't exceed the basis when CALENDAR rule is
  // in use.
  return Math.max(0, Math.min(days, input.workingDays))
}

// ─── OT pay ──────────────────────────────────────────────────────────────

/**
 * Hourly rate derived from monthly salary, using 8 work-hours per day
 * × the working-days basis. Returns 0 for non-MONTHLY profiles or
 * when monthlySalary is unset.
 */
export function deriveHourlyRate(input: {
  salaryType: SalaryType
  monthlySalary: number | null
  hourlyRate: number | null
  /// Working-days basis (e.g. 26 for the Malaysian convention) — comes
  /// from `PayrollSettings.workingDaysRule`.
  workingDays: number
  /// Daily working hours. For monthly employees this is the divisor in
  /// `monthly ÷ (workingDays × dailyHours)`. Defaults to 8 when the
  /// caller doesn't have a project-derived value.
  dailyHours?: number
}): number {
  if (input.salaryType === "HOURLY") return input.hourlyRate ?? 0
  if (input.monthlySalary == null || input.workingDays <= 0) return 0
  const hours = input.dailyHours && input.dailyHours > 0 ? input.dailyHours : 8
  return input.monthlySalary / (input.workingDays * hours)
}

/// Resolve effective daily working hours for an employee. Prefers the
/// employee's primary project hours (minus the lunch break), falling
/// back to the organization's working hours.
export function deriveDailyHours(input: {
  project: {
    workingHoursStart: string | null
    workingHoursEnd: string | null
    lunchBreakMinutes: number | null
  } | null
  org: { workingHoursStart: string; workingHoursEnd: string }
  defaultLunchMinutes?: number
}): number {
  const start =
    input.project?.workingHoursStart ?? input.org.workingHoursStart
  const end = input.project?.workingHoursEnd ?? input.org.workingHoursEnd
  const lunch =
    input.project?.lunchBreakMinutes ?? input.defaultLunchMinutes ?? 60
  const startM = hhmmToMinutes(start)
  const endM = hhmmToMinutes(end)
  if (endM <= startM) return 8
  return Math.max(0, endM - startM - lunch) / 60
}

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(":").map((v) => Number(v))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return h * 60 + m
}

/**
 * Compute the OT pay component given OT hours by category and the
 * org's OT multipliers. Returns one combined number; the breakdown is
 * persisted on the Payslip separately for audit.
 */
export function calcOtPay(input: {
  hourlyRate: number
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  otRateNormal: number // multiplier, e.g. 1.5
  otRateRest: number
  otRatePublicHoliday: number
}): number {
  const normal = input.otNormalHours * input.hourlyRate * input.otRateNormal
  const rest = input.otRestHours * input.hourlyRate * input.otRateRest
  const pub = input.otPublicHours * input.hourlyRate * input.otRatePublicHoliday
  return round2(normal + rest + pub)
}

// ─── Allowances / deductions ─────────────────────────────────────────────

/** Sum recurring positive earnings. Defensive: trims out negatives. */
export function sumAllowances(items: FixedAllowance[]): number {
  let total = 0
  for (const item of items) {
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[item.category]
    if (meta?.kind !== "DEDUCTION" && item.amount > 0) total += item.amount
  }
  return round2(total)
}

// ─── Orchestrator ────────────────────────────────────────────────────────

/**
 * Inputs to `calcPayslip`: everything the calc engine needs in one
 * frozen snapshot. Pure — does not touch the DB.
 */
export type CalcPayslipInput = {
  /// Profile snapshot at calc time.
  profile: Pick<
    PayrollProfileData,
    | "salaryType"
    | "monthlySalary"
    | "hourlyRate"
    | "fixedAllowances"
    | "joinDate"
    | "leaveDate"
    | "nationality"
    | "hasPr"
    | "isResident"
    | "isOku"
    | "spouseWorking"
    | "spouseDisabled"
    | "childRelief"
    | "dateOfBirth"
    | "contributeToEpf"
    | "epfMemberBefore1998"
    | "epfEmployeeRate"
    | "epfEmployeeVoluntary"
    | "epfEmployerVoluntary"
    | "socsoScheme"
    | "contributeToEis"
    | "incomeTaxNumber"
    | "epfNumber"
    | "socsoNumber"
  >
  /// Org-level operational settings.
  settings: {
    otRateNormal: number
    otRateRest: number
    otRatePublicHoliday: number
    workingDaysRule: WorkingDaysRule
    defaultEpfEmployeeRate: number
    defaultEpfEmployerRate: number
    /// HRDF (HRD Corp levy) toggle + rate %, e.g. 1.0 for compulsory
    /// registered employers or 0.5 for optional registered employers
    /// below required headcount. Applied to Malaysian citizens only
    /// (PSMB Act § 2). Wage base = proratedPay + sum of allowances
    /// flagged `subjectToHrdf` (excludes OT, reimbursements, travel,
    /// gratuity, bonus, commission). Unpaid leave reduces the base
    /// via the `deduct_unpaid_leave` line item.
    hrdfEnabled: boolean
    hrdfRate: number | null
    /// Auto-apply the RM 350/year combined SOCSO + EIS relief in
    /// the monthly PCB calc. Default true (HReasily-style); set
    /// false to treat the relief as a TP1 item the employee must
    /// declare themselves (strict LHDN MTD Spec). Optional so
    /// pre-existing callers keep compiling.
    autoApplySocsoEisRelief?: boolean
  }
  /// Period being run.
  periodYear: number
  periodMonth: number
  /// Daily working hours for the monthly→hourly conversion. Derived
  /// from the employee's primary project (or the org fallback) by the
  /// caller. When omitted, defaults to 8 — same as the legacy formula.
  dailyHours?: number
  /// Optional inputs that aren't stored on the profile.
  otNormalHours?: number
  otRestHours?: number
  otPublicHours?: number
  workedHours?: number | null
  /// Already-approved claims attached as REIMBURSEMENT line items.
  /// Phase 5 wires these up; for now pass [].
  reimbursements?: Array<{ id: string; label: string; amount: number }>
  /// Manual one-off deductions for this run.
  manualDeductions?: Array<{ label: string; amount: number }>
  /// PCB year-to-date (this calendar year, prior SUBMITTED runs).
  /// Caller (generate service) should add prev-employer carryover
  /// (PayrollProfile.prevRemuneration + prevEpf + prevPcb + prevZakat)
  /// into these figures when the employee joined mid-year.
  ytdTaxable?: number
  ytdEpf?: number
  ytdPcb?: number
  /// YTD zakat paid (excluding the current month). Subtracted from
  /// the annual tax in `calcPcb` per the LHDN MTD formula `MTD =
  /// [(P-M)R + B - (Z + X)] / (n+1)`. Sourced by the run service
  /// from prior SUBMITTED payslips' `zakat` totals, plus any
  /// prev-employer carryover from `PayrollProfile.prevZakat`.
  ytdZakat?: number
  /// YTD SOCSO + EIS employee contributions (sum of socsoEmployee +
  /// eisEmployee) from prior SUBMITTED payslips this calendar year.
  /// Used by `calcPcb` to apply the RM 350/year SOCSO+EIS relief.
  /// Defaults to 0; caller (run service) populates from
  /// `payslipRepository.getYtdForEmployee`.
  ytdSocsoEis?: number
  /// YTD per-category allowance totals (RM) — used to enforce
  /// `taxExemptLimit` caps. Keyed by `PayrollAdjustmentCategory` (e.g.
  /// `allowance_childcare`). Only the over-cap portion of an
  /// allowance contributes to the PCB base; the exempt portion stays
  /// off the PCB wage even when `subjectToPcb: true`. Caller (run
  /// service) populates this by summing prior SUBMITTED payslip line
  /// items grouped by category.
  ytdAllowanceByCategory?: Record<string, number>
}

/**
 * Result of `calcPayslip`. Mirrors the relevant columns on the
 * Payslip + PayslipLineItem models so the repo can write directly
 * from this shape.
 */
export type CalcPayslipResult = {
  // Hours / proration
  workedHours: number | null
  proratedFactor: number
  proratedDays: number
  totalWorkingDays: number
  // Money
  basicPay: number
  proratedPay: number
  otPay: number
  totalAllowances: number
  totalReimbursements: number
  totalDeductions: number
  // OT breakdown
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  // Statutory
  epfEmployee: number
  epfEmployer: number
  socsoEmployee: number
  socsoEmployer: number
  eisEmployee: number
  eisEmployer: number
  pcb: number
  hrdf: number
  hrdfWage: number
  zakat: number
  // Aggregates
  grossPay: number
  netPay: number
  totalCostToEmployer: number
  /// Sum of non-cash benefits (BIK / perquisites) attached to this
  /// payslip. Does NOT contribute to grossPay or netPay — surfaced
  /// separately so the payslip can show "Gross + BIK = Taxable
  /// Income" for transparency (Form EA reflects this split too).
  totalBenefitsInKind: number
  /// Sub-breakdown of `pcb`. `normal` is the PCB on recurring monthly
  /// pay; `additional` is the PCB attributable to one-off remuneration
  /// (bonus, commission, etc.) computed via the LHDN AR formula.
  pcbBreakdown: { normal: number; additional: number }
  // Line items the repo should write alongside the payslip
  lineItems: Array<{
    kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
    label: string
    amount: number
    /// `PayrollAdjustmentCategory` code when known (every line item
    /// coming from `profile.fixedAllowances` carries one). Null only
    /// for free-form manual deductions and Phase-5 reimbursements
    /// that don't map to a known category.
    category: string | null
    claimId?: string
    subjectToEpf: boolean
    subjectToSocso: boolean
    subjectToEis: boolean
    subjectToPcb: boolean
  }>
  /// EPF rate snapshot to store on the payslip (audit trail).
  epfRatesSnapshot: {
    employee: number
    employer: number
    voluntaryEmployee: number
    voluntaryEmployer: number
  }
  /// Non-blocking warnings about statutory data that is required for
  /// LHDN/PERKESO/KWSP filing or submission but missing from the
  /// profile. The calc itself proceeds (e.g. PCB is still computed)
  /// but the admin should resolve these before the run is submitted.
  /// Stable, machine-readable codes — admin UI maps to copy.
  statutoryWarnings: Array<
    | "MISSING_INCOME_TAX_NUMBER"
    | "MISSING_EPF_NUMBER"
    | "MISSING_SOCSO_NUMBER"
  >
}

/**
 * Run the calc engine end-to-end. Order is:
 *
 *   1. Resolve working-days basis + hourly rate
 *   2. Prorate basic pay if join/leave dates clip the period
 *   3. Compute OT pay
 *   4. Sum allowances (fixed + per-run via line items)
 *   5. Sum reimbursements (from approved claims)
 *   6. Sum deductions (manual + unpaid leave)
 *   7. Build EPF wage = prorated + OT + allowances (excludes reimbursements)
 *   8. Calculate EPF / SOCSO / EIS off the EPF wage
 *   9. Compute gross, net, cost-to-employer
 *
 * Returns a `CalcPayslipResult` ready for the repo to persist. Throws
 * only on invalid inputs (e.g. employee joined after the period
 * ended); callers should pre-filter via `effectiveWorkedDays`.
 */
export function calcPayslip(input: CalcPayslipInput): CalcPayslipResult {
  const { profile, settings, periodYear, periodMonth } = input

  // 1. Working-days + hourly rate.
  const totalWorkingDays = workingDaysForPeriod({
    year: periodYear,
    month: periodMonth,
    rule: settings.workingDaysRule,
  })

  const hourlyRate = deriveHourlyRate({
    salaryType: profile.salaryType,
    monthlySalary: profile.monthlySalary,
    hourlyRate: profile.hourlyRate,
    workingDays: totalWorkingDays,
    dailyHours: input.dailyHours,
  })

  // 2. Basic + proration.
  const workedDays =
    effectiveWorkedDays({
      periodYear,
      periodMonth,
      joinDate: profile.joinDate,
      leaveDate: profile.leaveDate,
      workingDays: totalWorkingDays,
    }) ?? 0

  const proratedFactor =
    totalWorkingDays > 0 ? round4(workedDays / totalWorkingDays) : 0

  let basicPay = 0
  if (profile.salaryType === "MONTHLY" && profile.monthlySalary != null) {
    basicPay = profile.monthlySalary
  } else if (profile.salaryType === "HOURLY") {
    const hours = input.workedHours ?? 0
    basicPay = round2(hours * (profile.hourlyRate ?? 0))
  }
  const proratedPay =
    profile.salaryType === "MONTHLY"
      ? round2(basicPay * proratedFactor)
      : basicPay // hourly = already exact, no proration

  // 3. OT.
  const otNormalHours = input.otNormalHours ?? 0
  const otRestHours = input.otRestHours ?? 0
  const otPublicHours = input.otPublicHours ?? 0
  const otPay = calcOtPay({
    hourlyRate,
    otNormalHours,
    otRestHours,
    otPublicHours,
    otRateNormal: settings.otRateNormal,
    otRateRest: settings.otRateRest,
    otRatePublicHoliday: settings.otRatePublicHoliday,
  })

  // 4. Fixed adjustments → line items.
  //
  // Each row routes through six buckets at once:
  //   - EPF / SOCSO / EIS bases (the wage figures the agencies see)
  //   - PCB normal base (for the recurring monthly pay annualised in
  //     PCB)
  //   - PCB AR amount + AR EPF (one-off bonus/commission/etc. handled
  //     by the LHDN additional-remuneration formula, not projected)
  //   - Zakat offset bucket (deduct_zakat amount that comes off PCB)
  //
  // `taxExemptLimit` from category meta gates how much of the row hits
  // the PCB bases. The exempt portion is min(thisRowAmt, remaining
  // cap headroom for the year). Anything over the cap still counts as
  // wages everywhere else (EPF/SOCSO/EIS), it just stops being
  // PCB-exempt.
  const ytdByCat = input.ytdAllowanceByCategory ?? {}
  const exemptUsedByCat: Record<string, number> = {}
  const lineItems: CalcPayslipResult["lineItems"] = []
  let totalAllowances = 0
  /// Sum of non-cash benefits (BIK / perquisites). These contribute to
  /// PCB taxable income (via `pcbAdjustmentBase`) but NOT to gross
  /// pay, since the employee never receives the amount in cash. The
  /// payslip surfaces this as a separate "Benefits in Kind" subtotal.
  let totalBenefitsInKind = 0
  let totalRecurringDeductions = 0
  let totalRecurringReimbursements = 0
  let epfAdjustmentBase = 0
  let socsoAdjustmentBase = 0
  let eisAdjustmentBase = 0
  let pcbAdjustmentBase = 0
  let pcbAdditionalRemuneration = 0
  let pcbAdditionalRemunerationEpf = 0
  let hrdfAdjustmentBase = 0
  let thisMonthZakat = 0
  for (const a of profile.fixedAllowances) {
    if (a.amount <= 0) continue
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[a.category]
    if (!meta) continue
    const amt = round2(a.amount * proratedFactor)

    // Compute how much of this row contributes to the PCB base. By
    // default it's `amt` (the full amount). When `taxExemptLimit` is
    // set, the first `cap - ytd_used` RM stay exempt, only the
    // overflow feeds PCB.
    let pcbTaxable = amt
    if (
      meta.kind === "ALLOWANCE" &&
      meta.subjectToPcb &&
      typeof meta.taxExemptLimit === "number"
    ) {
      const ytdUsed =
        (ytdByCat[a.category] ?? 0) + (exemptUsedByCat[a.category] ?? 0)
      const remainingCap = Math.max(0, meta.taxExemptLimit - ytdUsed)
      const exemptPortion = Math.min(amt, remainingCap)
      pcbTaxable = round2(Math.max(0, amt - exemptPortion))
      exemptUsedByCat[a.category] =
        (exemptUsedByCat[a.category] ?? 0) + exemptPortion
    }

    if (meta.kind === "DEDUCTION") {
      totalRecurringDeductions += amt
      if (meta.reducesBase) {
        if (meta.subjectToEpf) epfAdjustmentBase -= amt
        if (meta.subjectToSocso) socsoAdjustmentBase -= amt
        if (meta.subjectToEis) eisAdjustmentBase -= amt
        if (meta.subjectToPcb) pcbAdjustmentBase -= pcbTaxable
        if (meta.subjectToHrdf) hrdfAdjustmentBase -= amt
      }
      if (meta.offsetsPcb) {
        thisMonthZakat += amt
      }
    } else if (meta.kind === "REIMBURSEMENT") {
      totalRecurringReimbursements += amt
    } else {
      // Non-cash benefits (BIK / perquisites) go into a separate
      // bucket — they DON'T inflate gross pay because the employee
      // never receives them in cash. They still feed the PCB taxable
      // base when `subjectToPcb: true` (e.g. company car, share
      // scheme, living accommodation), and they're flagged in the
      // line-item list so the payslip can show them under "Benefits
      // in Kind" instead of "Allowances".
      //
      // Cash allowances (the default) feed `totalAllowances` and
      // therefore gross pay, plus the relevant statutory bases per
      // the meta flags.
      if (meta.nonCash) {
        totalBenefitsInKind += amt
        // BIK is not wage income, so it's never EPF/SOCSO/EIS/HRDF
        // subject. The flags on each BIK meta entry should already
        // be false for those — defensive assertion handled by the
        // existing `subjectTo*` flags (we just don't add to those
        // bases here).
        if (meta.subjectToPcb) {
          if (meta.isAdditionalRemuneration) {
            pcbAdditionalRemuneration += pcbTaxable
          } else {
            pcbAdjustmentBase += pcbTaxable
          }
        }
      } else {
        totalAllowances += amt
        if (meta.subjectToEpf) epfAdjustmentBase += amt
        if (meta.subjectToSocso) socsoAdjustmentBase += amt
        if (meta.subjectToEis) eisAdjustmentBase += amt
        if (meta.subjectToHrdf) hrdfAdjustmentBase += amt
        if (meta.subjectToPcb) {
          if (meta.isAdditionalRemuneration) {
            pcbAdditionalRemuneration += pcbTaxable
            // AR EPF — only the portion of EPF attributable to the AR
            // row needs to count toward the with-AR annual EPF bucket.
            // EPF cap (RM4k) is honoured by `calcPcb` regardless.
            if (meta.subjectToEpf) {
              const rate = profile.epfEmployeeRate || settings.defaultEpfEmployeeRate
              pcbAdditionalRemunerationEpf += round2(amt * (rate / 100))
            }
          } else {
            pcbAdjustmentBase += pcbTaxable
          }
        }
      }
    }
    lineItems.push({
      kind: meta.kind,
      label: a.name || meta.label,
      amount: amt,
      category: a.category,
      subjectToEpf: meta.subjectToEpf,
      subjectToSocso: meta.subjectToSocso,
      subjectToEis: meta.subjectToEis,
      subjectToPcb: meta.subjectToPcb,
    })
  }
  totalAllowances = round2(totalAllowances)
  totalBenefitsInKind = round2(totalBenefitsInKind)
  totalRecurringDeductions = round2(totalRecurringDeductions)
  totalRecurringReimbursements = round2(totalRecurringReimbursements)
  pcbAdditionalRemuneration = round2(pcbAdditionalRemuneration)
  pcbAdditionalRemunerationEpf = round2(pcbAdditionalRemunerationEpf)
  hrdfAdjustmentBase = round2(hrdfAdjustmentBase)
  thisMonthZakat = round2(thisMonthZakat)

  // 5. Reimbursements (Phase 5 — approved claims). Not wage-like, so
  // not subject to statutory contributions.
  let totalReimbursements = totalRecurringReimbursements
  for (const r of input.reimbursements ?? []) {
    totalReimbursements += r.amount
    lineItems.push({
      kind: "REIMBURSEMENT",
      label: r.label,
      amount: round2(r.amount),
      category: null,
      claimId: r.id,
      subjectToEpf: false,
      subjectToSocso: false,
      subjectToEis: false,
      subjectToPcb: false,
    })
  }
  totalReimbursements = round2(totalReimbursements)

  // 6. Manual deductions. Unpaid leave is one of the recurring/manual
  // line items now — it's a regular DEDUCTION-kind line with
  // `reducesBase: true` and `subjectToHrdf: true`, so it lands in
  // `totalRecurringDeductions` and the right adjustment-base buckets
  // automatically.
  let totalDeductions = round2(totalRecurringDeductions)
  for (const d of input.manualDeductions ?? []) {
    if (d.amount <= 0) continue
    totalDeductions += d.amount
    lineItems.push({
      kind: "DEDUCTION",
      label: d.label || "Deduction",
      amount: round2(d.amount),
      category: null,
      subjectToEpf: true,
      subjectToSocso: true,
      subjectToEis: true,
      subjectToPcb: true,
    })
  }
  totalDeductions = round2(totalDeductions)

  // 7. Statutory wages. Different agencies use different wage bases:
  // EPF excludes OT, while SOCSO/EIS/PCB include OT. Category metadata
  // controls whether each fixed adjustment participates in each base.
  const epfWage = round2(Math.max(0, proratedPay + epfAdjustmentBase))
  const socsoWage = round2(
    Math.max(0, proratedPay + otPay + socsoAdjustmentBase),
  )
  const eisWage = round2(Math.max(0, proratedPay + otPay + eisAdjustmentBase))
  const pcbWage = round2(Math.max(0, proratedPay + otPay + pcbAdjustmentBase))

  // 8. EPF / SOCSO / EIS.
  // Citizenship detection — accept multiple spellings/variants
  // case-insensitively. "Malaysia" (country) and "Malaysian"
  // (adjective) both count as citizenship; "my" / "mys" / "kl" are
  // common shorthand on imported spreadsheets.
  const isMalaysianCitizen = isMalaysianNationality(profile.nationality)

  const employeeRate =
    profile.epfEmployeeRate || settings.defaultEpfEmployeeRate
  const ageAtPeriodEnd = ageAtEndOfPeriod(
    profile.dateOfBirth,
    periodYear,
    periodMonth,
  )
  const epf = calcEpf({
    wage: epfWage,
    employeeRate,
    employeeVoluntary: profile.epfEmployeeVoluntary,
    employerVoluntary: profile.epfEmployerVoluntary,
    contributeToEpf: profile.contributeToEpf,
    isMalaysianCitizen,
    hasPr: profile.hasPr,
    epfMemberBefore1998: profile.epfMemberBefore1998,
    ageAtPeriodEnd,
  })

  const socso = calcSocso({
    wage: socsoWage,
    scheme: profile.socsoScheme,
  })

  // EIS eligibility per PERKESO EIS Act 2017 + the EIS coverage flyer:
  //   - All employees in the private sector, including Malaysians,
  //     PR holders, AND temporary residents (foreign workers with a
  //     valid permit). Citizenship is NOT a gate.
  //   - Contribution age range: 18 to 60 (inclusive lower, exclusive
  //     upper). Below 18 or 60+ → no EIS.
  //   - First-time contributors aged 57+ are exempt — handled by the
  //     admin un-ticking `contributeToEis` on the profile, which the
  //     check below honours.
  //
  // When `dateOfBirth` is null the helper returns 0; we cannot tell
  // whether the employee is in range, so we defer to the admin's
  // `contributeToEis` flag rather than blocking outright.
  const eisAgeEligible =
    profile.dateOfBirth == null ||
    (ageAtPeriodEnd >= 18 && ageAtPeriodEnd < 60)
  const eis = calcEis({
    wage: eisWage,
    contributeToEis: profile.contributeToEis && eisAgeEligible,
  })

  // 9. PCB (Potongan Cukai Bulanan). Computed for every employee
  // every run per LHDN MTD Specification for 2026 — the spec never
  // gates the calculation on whether the employee has a TIN on file.
  // (The TIN is required only for the CP39 submission text file —
  // see `statutoryWarnings` below for how that is surfaced.) Non-
  // residents fall to flat 30%; residents follow LHDN's normal-
  // remuneration formula plus the additional-remuneration delta
  // formula for one-off bonus/commission/etc. See `domain/pcb.ts`
  // for the full set of caveats.
  //
  // EPF passed to calcPcb is the EPF contribution from the NORMAL
  // monthly pay only — AR EPF is carried separately so the with-AR
  // branch can add it to the annual EPF estimate without inflating
  // the normal projection.
  const epfFromNormal = round2(
    Math.max(0, epf.employee - pcbAdditionalRemunerationEpf),
  )
  // SOCSO + EIS employee contributions feed the RM 350/year combined
  // relief inside calcPcb. We auto-apply this (it would otherwise be
  // a TP1 item) because the employer already knows the exact figure
  // — see SOCSO_EIS_RELIEF_CAP in pcb.ts for the rationale.
  // Honour the org-level "Auto-apply SOCSO + EIS relief" setting.
  // When the admin turns it off, we hand calcPcb zero figures so
  // the RM 350 relief is effectively not applied — the employee
  // would then claim it at year-end via Form BE or via TP1.
  // Default true matches the pre-toggle behaviour.
  const autoApplySocsoEis = settings.autoApplySocsoEisRelief !== false
  const thisMonthSocsoEis = autoApplySocsoEis
    ? round2(socso.employee + eis.employee)
    : 0
  const ytdSocsoEisForRelief = autoApplySocsoEis
    ? (input.ytdSocsoEis ?? 0)
    : 0

  const pcbBreakdown = calcPcb({
    isResident: profile.isResident,
    periodMonth,
    thisMonthTaxable: pcbWage,
    thisMonthEpf: epfFromNormal,
    thisMonthAdditionalRemuneration: pcbAdditionalRemuneration,
    thisMonthEpfFromAR: pcbAdditionalRemunerationEpf,
    ytdTaxable: input.ytdTaxable ?? 0,
    ytdEpf: input.ytdEpf ?? 0,
    ytdPcb: input.ytdPcb ?? 0,
    ytdZakat: input.ytdZakat ?? 0,
    thisMonthSocsoEis,
    ytdSocsoEis: ytdSocsoEisForRelief,
    profile: {
      isOku: profile.isOku,
      spouseWorking: profile.spouseWorking,
      spouseDisabled: profile.spouseDisabled,
      childRelief: profile.childRelief,
    },
  })
  // Zakat offset: any `deduct_zakat` line items reduce PCB owed for
  // the month (capped at PCB). Zakat is still listed as a deduction on
  // the payslip — the offset means the employee effectively pays
  // zakat *out of* their PCB obligation rather than on top of it.
  const pcbBeforeZakat = pcbBreakdown.total
  const zakatOffset = Math.min(pcbBeforeZakat, thisMonthZakat)
  const pcb = round2(Math.max(0, pcbBeforeZakat - zakatOffset))

  // 10. HRDF (HRD Corp levy). Per PSMB Act 2001 § 2 "wages":
  //
  //     wages = basic salary + fixed allowances of a like nature
  //           + leave pay + arrears (all paid in cash)
  //
  //     EXCLUDES: travel allowance, special-expense reimbursements,
  //               gratuity on discharge/retirement, bonus,
  //               commission, apprentice allowances.
  //
  // `hrdfAdjustmentBase` already excludes the right categories
  // (filtered by `meta.subjectToHrdf` in the line-item loop), so
  // levy wage = proratedPay + hrdfAdjustmentBase. OT and
  // reimbursements are not included. DEDUCTION rows reduce the base
  // when `reducesBase: true` AND `subjectToHrdf: true` —
  // `deduct_unpaid_leave` is set up that way so unpaid-leave line
  // items lower the HRDF wage naturally.
  //
  // Eligibility: per PSMB Act § 2 "employee" = "any citizen of
  // Malaysia". PR holders + foreign workers are NOT covered, and the
  // `isMalaysianCitizen` gate above enforces this.
  const hrdfRate = settings.hrdfRate ?? 0
  const hrdfActive =
    settings.hrdfEnabled && hrdfRate > 0 && isMalaysianCitizen
  const hrdfWage = hrdfActive
    ? round2(Math.max(0, proratedPay + hrdfAdjustmentBase))
    : 0
  const hrdf = hrdfActive ? round2(hrdfWage * (hrdfRate / 100)) : 0

  // 10. Gross / Net / Cost to employer.
  // Gross = prorated + OT + allowances + reimbursements (what the
  // employee sees on the payslip before deductions).
  const grossPay = round2(
    proratedPay + otPay + totalAllowances + totalReimbursements,
  )
  // Zakat is already inside `totalDeductions` (kind: DEDUCTION line
  // items get counted there) — don't subtract it again here. The
  // zakat → PCB offset has already lowered `pcb` to its post-offset
  // value, which is what the employee actually pays.
  const netPay = round2(
    grossPay -
      epf.employee -
      socso.employee -
      eis.employee -
      totalDeductions -
      pcb,
  )
  const totalCostToEmployer = round2(
    grossPay +
      epf.employer +
      socso.employer +
      eis.employer +
      hrdf,
  )

  // Non-blocking warnings about missing statutory identifiers. PCB is
  // still computed (LHDN spec doesn't gate the calc on TIN), but the
  // submission file (CP39) requires the TIN, and EPF/SOCSO
  // submissions need their respective member numbers. Admin UI uses
  // these codes to surface a "fix before submit" banner.
  const statutoryWarnings: CalcPayslipResult["statutoryWarnings"] = []
  if (
    typeof profile.incomeTaxNumber !== "string" ||
    profile.incomeTaxNumber.trim().length === 0
  ) {
    statutoryWarnings.push("MISSING_INCOME_TAX_NUMBER")
  }
  if (
    profile.contributeToEpf &&
    (typeof profile.epfNumber !== "string" ||
      profile.epfNumber.trim().length === 0)
  ) {
    statutoryWarnings.push("MISSING_EPF_NUMBER")
  }
  if (
    profile.socsoScheme &&
    (typeof profile.socsoNumber !== "string" ||
      profile.socsoNumber.trim().length === 0)
  ) {
    statutoryWarnings.push("MISSING_SOCSO_NUMBER")
  }

  return {
    workedHours: input.workedHours ?? null,
    proratedFactor,
    proratedDays: workedDays,
    totalWorkingDays,
    basicPay: round2(basicPay),
    proratedPay,
    otPay,
    otNormalHours,
    otRestHours,
    otPublicHours,
    totalAllowances,
    totalBenefitsInKind,
    totalReimbursements,
    totalDeductions,
    epfEmployee: epf.employee,
    epfEmployer: epf.employer,
    socsoEmployee: socso.employee,
    socsoEmployer: socso.employer,
    eisEmployee: eis.employee,
    eisEmployer: eis.employer,
    pcb,
    hrdf,
    hrdfWage,
    /// Zakat actually deducted this month — sourced from
    /// `deduct_zakat` line items and offset against PCB. Stored on
    /// the payslip for the LHDN report (CP159/EA).
    zakat: thisMonthZakat,
    grossPay,
    netPay,
    totalCostToEmployer,
    pcbBreakdown: {
      normal: pcbBreakdown.normal,
      additional: pcbBreakdown.additional,
    },
    lineItems,
    epfRatesSnapshot: epfSnapshotRates({
      branch: epf.branch,
      profileEmployeeRate: employeeRate,
      wage: epfWage,
      voluntaryEmployee: profile.epfEmployeeVoluntary,
      voluntaryEmployer: profile.epfEmployerVoluntary,
    }),
    statutoryWarnings,
  }
}

/**
 * Snapshot rates by KWSP branch. The numbers stored on the payslip
 * reflect what the calc actually applied, not the profile's declared
 * rate (which the engine overrides for non-Part-A branches).
 */
function epfSnapshotRates(input: {
  branch: EpfBranch
  profileEmployeeRate: number
  wage: number
  voluntaryEmployee: number
  voluntaryEmployer: number
}): {
  employee: number
  employer: number
  voluntaryEmployee: number
  voluntaryEmployer: number
} {
  let employee = 0
  let employer = 0
  switch (input.branch) {
    case "MALAYSIAN_UNDER_60":
      // Mirror the floor enforced in calcEpf: minimum statutory
      // employee share is 11%. Snapshot what the calc actually used.
      employee = Math.max(11, input.profileEmployeeRate)
      employer = input.wage <= 5000 ? 13 : 12
      break
    case "MALAYSIAN_CITIZEN_60_PLUS":
      employee = 0
      employer = 4
      break
    case "PR_OR_PRE1998_60_PLUS":
      employee = 5.5
      employer = input.wage <= 5000 ? 6.5 : 6
      break
    case "POST_1998_NON_MALAYSIAN":
      employee = 2
      employer = 2
      break
    case "OPTED_OUT":
    case "DE_MINIMIS":
      employee = 0
      employer = 0
      break
  }
  return {
    employee,
    employer,
    voluntaryEmployee: input.voluntaryEmployee,
    voluntaryEmployer: input.voluntaryEmployer,
  }
}

/**
 * Compute the employee's age at the last day of the payroll period.
 * Returns 0 when `dateOfBirth` isn't set (caller treats as "under 60",
 * so under-60 rates apply by default — matches conservative behaviour).
 */
function ageAtEndOfPeriod(
  dateOfBirth: string | null,
  periodYear: number,
  periodMonth: number,
): number {
  if (!dateOfBirth) return 0
  const dob = Date.parse(dateOfBirth)
  if (Number.isNaN(dob)) return 0
  const dobDate = new Date(dob)
  const lastDayOfMonth = new Date(Date.UTC(periodYear, periodMonth, 0))

  let age = lastDayOfMonth.getUTCFullYear() - dobDate.getUTCFullYear()
  // Subtract a year if the birthday hasn't happened yet in this period.
  const monthDelta = lastDayOfMonth.getUTCMonth() - dobDate.getUTCMonth()
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && lastDayOfMonth.getUTCDate() < dobDate.getUTCDate())
  ) {
    age -= 1
  }
  return Math.max(0, age)
}

// ─── Tiny rounding helper ───────────────────────────────────────────────

/** Round to 4 decimal places — used for the proratedFactor column. */
/**
 * Detect Malaysian citizenship from the `nationality` free-text field
 * on a payroll profile. Accepts a few common spellings/variants
 * case-insensitively:
 *
 *   - "Malaysian" (adjective — what the template uses)
 *   - "Malaysia"  (country name — common when imported from a HR CSV)
 *   - "MY" / "MYS" (ISO country codes)
 *   - "warganegara malaysia" / "rakyat malaysia" (BM)
 *
 * Returns false for blank values, non-Malaysian nationalities, or
 * unrecognised strings. Used by EPF + HRDF + PCB branch resolvers
 * and the Statutory tab branch display.
 */
export function isMalaysianNationality(
  nationality: string | null | undefined,
): boolean {
  const v = (nationality ?? "").toLowerCase().trim()
  if (v === "") return false
  return (
    v === "malaysian" ||
    v === "malaysia" ||
    v === "my" ||
    v === "mys" ||
    v.includes("warganegara malaysia") ||
    v.includes("rakyat malaysia")
  )
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 10_000) / 10_000
}
