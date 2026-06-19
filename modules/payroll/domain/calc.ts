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
import {
  calcPcb,
  calcPcbBreakdown,
  type CalcPcbBreakdown,
} from "@/modules/payroll/domain/pcb"
import type { PayslipEpfRatesSnapshot } from "@/modules/payroll/domain/runs"
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
  /// Regular monthly EPF-able wage (base salary + recurring allowances).
  /// THIS is what determines the 13%/12% KWSP Third Schedule tier and
  /// drives the gazetted band-table lookup. AR amounts (one-off bonus,
  /// commission, arrears) do NOT belong here — they go in
  /// `additionalRemuneration` so the tier doesn't get pushed past
  /// RM 5,000 just because a bonus landed this run.
  wage: number
  /// Optional. EPF-able amounts treated as Additional Remuneration —
  /// bonus / commission / arrears whose category is
  /// `isAdditionalRemuneration: true` AND the user did NOT tick
  /// "Treat as regular monthly remuneration" on that line. The AR
  /// portion gets EPF at the SAME rate the regular tier qualifies for
  /// (e.g. 13% if regular wage ≤ 5,000), computed as exact percentage
  /// rounded up to next ringgit (KWSP general rule for off-table
  /// amounts). Defaults to 0 when omitted.
  additionalRemuneration?: number
  /// Optional. The wage used to decide which side of the KWSP Third
  /// Schedule RM 5,000 cliff the employer rate falls on (13→12 for
  /// Part A, 6.5→6 for Part C). Defaults to `wage`. Passed by the
  /// orchestrator as the *regular monthly* EPF-able wage (i.e. without
  /// one-off bonus / commission AR amounts) so a bonus paid this
  /// period doesn't kick an under-RM-5,000 employee into the higher
  /// tier for one month. Matches Payroll Panda's behaviour.
  rateDeterminingWage?: number
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
      // Part F — flat 2%/2% per the KWSP Contribution Rate table.
      // Applies to non-Malaysians who registered as members on or
      // after 1 August 1998, regardless of age. Supersedes the older
      // Third Schedule Parts B / D (flat RM 5 + 11% or 5.5% employee).
      // Effective for October 2025 salary / November 2025 contribution
      // month. Source: KWSP official Contribution Rate table — Third
      // Schedule Part F.
      employeeRate = 2
      employerRateLow = 2
      employerRateHigh = 2
      break
  }

  const ar = input.additionalRemuneration ?? 0
  const totalWage = input.wage + ar
  // `rateWage` decides which side of the RM 5,000 cliff the EMPLOYER
  // rate falls on (13→12 for Part A, 6.5→6 for Part C). Caller passes
  // the regular monthly EPF-able wage here so a one-off bonus that
  // month doesn't kick an under-RM-5,000 employee into the higher
  // tier. Defaults to `wage` for backwards-compatible call sites.
  const rateWage = input.rateDeterminingWage ?? input.wage

  // Employer EPF — single ceil of (mandatory + voluntary) × combined
  // wage. Avoids the double-ceil drift between mandatory and voluntary
  // that previously left us RM 1 above Panda on bonus months. Cliff
  // for the mandatory rate is driven by `rateWage` (regular monthly),
  // NOT combined wage — so a one-off bonus that pushes the month's
  // total past RM 5,000 keeps the employee on the 13% Part A low tier
  // when their contractual wage is under RM 5,000.
  const employerMandatoryRate =
    rateWage <= 5000 ? employerRateLow : employerRateHigh
  const employerTotalRate =
    employerMandatoryRate + (input.employerVoluntary > 0 ? input.employerVoluntary : 0)
  const employerTotal =
    totalWage > 0
      ? Math.ceil(totalWage * employerTotalRate / 100)
      : 0

  // Employee EPF — two paths depending on which side of the gazetted
  // Schedule we're on:
  //
  //   1. Band-table branches (Parts A and C, hasCliff === true) with
  //      wage ≤ RM 20,000 → KWSP mandates the gazetted table for the
  //      mandatory side. We take it via `lookupEpfBand`, then add the
  //      voluntary as a separate ceil (the Schedule has no concept of
  //      voluntary, so off-table rules apply to it).
  //
  //   2. Off-table cases — flat-rate branches (Parts E and F,
  //      hasCliff === false) OR any branch with wage > RM 20,000.
  //      KWSP's off-table rule says "exact percentage, each side
  //      rounded UP to next ringgit". `Each side` here = employee /
  //      employer (one ceil per side), NOT each component (mandatory
  //      separate from voluntary). So combine the rates and single-
  //      ceil the total — matches Payroll Panda. Pre-fix, Asim (Part
  //      F: 2% mandatory + 9% voluntary at wage 14,645) was producing
  //      ceil(293) + ceil(1,319) = 1,612 instead of ceil(1,611) = 1,611.
  const hasCliff = employerRateLow !== employerRateHigh
  const usesBandTable = hasCliff && totalWage <= 20000
  let employee: number
  if (usesBandTable) {
    const employeeBand = lookupEpfBand({
      wage: totalWage,
      employerRateLow,
      employerRateHigh,
      employeeRate,
    })
    const employeeExtra =
      input.employeeVoluntary > 0
        ? Math.ceil(totalWage * input.employeeVoluntary / 100)
        : 0
    employee = employeeBand.employee + employeeExtra
  } else {
    const employeeTotalRate =
      employeeRate +
      (input.employeeVoluntary > 0 ? input.employeeVoluntary : 0)
    employee = totalWage > 0
      ? Math.ceil(totalWage * employeeTotalRate / 100)
      : 0
  }

  return {
    employee: round2(employee),
    employer: round2(employerTotal),
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
  /// Proration rule. CALENDAR counts calendar days for a partial period;
  /// TWENTY_SIX counts only configured working days (weekday set).
  /// Defaults to TWENTY_SIX.
  rule?: WorkingDaysRule
  /// ISO weekdays (1=Mon … 7=Sun) treated as working days. Used to count
  /// eligible days for a partial period under the TWENTY_SIX rule.
  /// Defaults to Mon–Fri.
  workingDaySet?: Set<number>
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

  const rule = input.rule ?? "TWENTY_SIX"
  let days: number
  if (rule === "CALENDAR") {
    // Calendar days from join/leave to the period boundary, inclusive.
    days = Math.round((endMs - startMs) / 86_400_000) + 1
  } else {
    // 26-day rule: count only configured working days (weekday set) in
    // the inclusive [start, end] range — e.g. 15→31 Jan = 13 Mon–Fri.
    const set = input.workingDaySet ?? new Set([1, 2, 3, 4, 5])
    days = 0
    const cursor = new Date(
      Date.UTC(
        new Date(startMs).getUTCFullYear(),
        new Date(startMs).getUTCMonth(),
        new Date(startMs).getUTCDate(),
      ),
    )
    const end = new Date(
      Date.UTC(
        new Date(endMs).getUTCFullYear(),
        new Date(endMs).getUTCMonth(),
        new Date(endMs).getUTCDate(),
      ),
    )
    while (cursor <= end) {
      // ISO weekday: Mon=1 … Sun=7 (JS getUTCDay is Sun=0 … Sat=6).
      const iso = ((cursor.getUTCDay() + 6) % 7) + 1
      if (set.has(iso)) days += 1
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  // Cap the worked-days at the working-days basis (e.g. 26).
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
  /// ISO weekdays (1=Mon … 7=Sun) the employee works — from their
  /// project/org config. Used to count eligible paid days for a partial
  /// (join/leave) month under the TWENTY_SIX rule. Defaults to Mon–Fri.
  workingDaySet?: Set<number>
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
  /// Full LHDN-style PCB formula breakdown (Y, K, Y1, K1, Y2, K2, n,
  /// D, S, Du, Su, Q×C, ∑LP, LP1, P, M, R, B, Z, X, yearlyTax,
  /// currentMonthPcb, pcbFinal). Persisted on the payslip as
  /// `pcbCalculation Json?` so the Detailed Calculations PDF can show
  /// the formula that produced the deducted amount.
  pcbCalculation: CalcPcbBreakdown
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
  /// EPF rate + amount snapshot to store on the payslip (audit trail).
  /// See `PayslipEpfRatesSnapshot` — carries both the % rates that
  /// applied and the RM amounts split into mandatory vs voluntary on
  /// each side, so the Detailed Calculations PDF can render them as
  /// separate lines.
  epfRatesSnapshot: PayslipEpfRatesSnapshot
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
      rule: settings.workingDaysRule,
      workingDaySet: input.workingDaySet,
    }) ?? 0

  // Use the EXACT ratio for money math; only round to 4dp for the
  // stored snapshot (proratedFactor). Rounding the factor before
  // multiplying loses cents — e.g. 4999.99 × round4(7/26) = 1346.00,
  // but 4999.99 × (7/26) = 1346.15.
  const prorationRatio =
    totalWorkingDays > 0 ? workedDays / totalWorkingDays : 0
  const proratedFactor = round4(prorationRatio)

  let basicPay = 0
  if (profile.salaryType === "MONTHLY" && profile.monthlySalary != null) {
    basicPay = profile.monthlySalary
  } else if (profile.salaryType === "HOURLY") {
    const hours = input.workedHours ?? 0
    basicPay = round2(hours * (profile.hourlyRate ?? 0))
  }
  const proratedPay =
    profile.salaryType === "MONTHLY"
      ? round2(basicPay * prorationRatio)
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
  /// Deductions that represent lost earnings (e.g. unpaid leave). These
  /// are subtracted from GROSS rather than from take-home, so they are
  /// NOT added to `totalRecurringDeductions` (which would double-count).
  let totalGrossReducingDeductions = 0
  let totalRecurringReimbursements = 0
  let epfAdjustmentBase = 0
  /// AR (additional remuneration) bucket for EPF — bonus / commission /
  /// arrears lines whose category is `isAdditionalRemuneration: true` AND
  /// the user did NOT tick "Treat as regular monthly remuneration". These
  /// amounts are EPF-able but kept OUT of the regular monthly EPF wage
  /// that determines the 13%/12% KWSP Third Schedule tier — instead the
  /// AR portion gets EPF computed separately at the regular tier's rate
  /// as exact percentage rounded up (KWSP general rule for off-table
  /// amounts). Matches the existing PCB AR vs recurring split.
  let arEpfBase = 0
  // EPF-subject amount that's flagged as AR for PCB purposes (i.e.
  // the bonus / commission line whose `treatAsRecurring` was left
  // unticked). Used after the main `calcEpf` call to derive Kt as the
  // band difference — see the comment on the accumulator-update site
  // and the post-calcEpf block below. The actual EPF deducted is
  // unaffected (always uses the combined-wage band lookup).
  let arEpfAmountForPcbKt = 0
  let socsoAdjustmentBase = 0
  let eisAdjustmentBase = 0
  let pcbAdjustmentBase = 0
  let pcbAdditionalRemuneration = 0
  // `pcbAdditionalRemunerationEpf` (the LHDN form's Kt) is computed
  // AFTER `calcEpf` runs, as a band difference. No longer accumulated
  // per AR line.
  let hrdfAdjustmentBase = 0
  let thisMonthZakat = 0
  for (const a of profile.fixedAllowances) {
    if (a.amount <= 0) continue
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[a.category]
    if (!meta) continue
    // Most recurring lines prorate with the salary (join/leave factor).
    // `skipProration` lines (e.g. unpaid leave) are already at the full
    // daily rate, so they're taken as-is. Use the exact ratio (not the
    // 4dp-rounded snapshot factor) to avoid losing cents.
    const amt = meta.skipProration
      ? round2(a.amount)
      : round2(a.amount * prorationRatio)

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
      // `reducesGross` rows (unpaid leave) are lost earnings — they come
      // off GROSS, not take-home, so they go in their own bucket and are
      // kept OUT of `totalRecurringDeductions` (else net double-counts).
      // `cashNeutral` rows (zakat paid outside payroll, declared via
      // TP1) lower PCB but are NOT subtracted from take-home — the
      // employee already paid the amount directly to the zakat centre.
      // So skip `totalRecurringDeductions` for them; the `offsetsPcb`
      // branch below still reduces the month's PCB.
      if (meta.reducesGross) {
        totalGrossReducingDeductions += amt
      } else if (!meta.cashNeutral) {
        totalRecurringDeductions += amt
      }
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
          // Per-item LHDN AR override: even on an AR-flagged category,
          // a `treatAsRecurring: true` line routes into the normal
          // bucket (smooth monthly PCB) instead of the one-shot AR
          // bucket (marginal-tax spike). Default is undefined/false →
          // current behaviour unchanged.
          const treatAsAdditional =
            meta.isAdditionalRemuneration && !a.treatAsRecurring
          if (treatAsAdditional) {
            pcbAdditionalRemuneration += pcbTaxable
          } else {
            pcbAdjustmentBase += pcbTaxable
          }
        }
      } else {
        totalAllowances += amt
        // The `treatAsRecurring` flag now ONLY controls PCB routing
        // (smoothed monthly vs LHDN one-shot AR formula). For EPF, all
        // wages paid in the month — including bonus / commission —
        // ALWAYS combine into the regular wage that determines the
        // KWSP Third Schedule tier (EPF Act 1991 §2 reads "wages"
        // broadly to include bonus paid in the contribution month).
        // Previously the flag drove both, which forced admins to
        // choose between "right EPF + wrong PCB" or "wrong EPF +
        // right PCB" on the bonus line. Matches Payroll Panda.
        const treatAsAdditional =
          meta.isAdditionalRemuneration && !a.treatAsRecurring
        if (meta.subjectToEpf) {
          epfAdjustmentBase += amt
          // Separately track the AR-flagged portion (for PCB Kt
          // derivation only — actual EPF deducted always uses the
          // combined wage above). The LHDN PCB form's Kt is the
          // marginal EPF the bonus adds on top of regular wage:
          //
          //   Kt = band(regular + bonus) − band(regular only)
          //
          // We accumulate the bonus amount here so we can rerun the
          // band lookup minus this amount after the main calcEpf
          // call, then take the difference. Pre-fix, this used the
          // straight exact-percentage (134 for Kay Ben), which made
          // K1 + Kt only equal the actual deducted EPF by coincidence
          // when the bonus didn't push across a band tier — and
          // attributed the tier-jump to K1 incorrectly when it did
          // (Kay Ben's K1 was reading 460 instead of 451).
          if (treatAsAdditional) {
            arEpfAmountForPcbKt += amt
          }
        }
        if (meta.subjectToSocso) socsoAdjustmentBase += amt
        if (meta.subjectToEis) eisAdjustmentBase += amt
        if (meta.subjectToHrdf) hrdfAdjustmentBase += amt
        if (meta.subjectToPcb) {
          if (treatAsAdditional) {
            pcbAdditionalRemuneration += pcbTaxable
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
  // Computed OT pay (from OT hours × OT rate × multiplier) is treated
  // as Additional Remuneration, matching the `isAdditionalRemuneration`
  // flag on the `wages_overtime` category meta. Strict LHDN MTD reading:
  // OT is non-fixed, so PCB on the OT portion runs through the AR
  // formula (PCB(C)) instead of being folded into PCB(B). SOCSO and
  // EIS bases still include OT — only PCB routing changes.
  pcbAdditionalRemuneration = round2(pcbAdditionalRemuneration + otPay)
  hrdfAdjustmentBase = round2(hrdfAdjustmentBase)

  // Self-paid zakat (Borang TP1 §D1(a)) is now just a `deduct_zakat_tp1`
  // adjustment line (offsetsPcb + cashNeutral), handled in the deduction
  // loop above — no separate profile-level branch needed.
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
  // EPF excludes OT entirely. SOCSO and EIS include OT in the regular
  // wage. PCB treats OT as Additional Remuneration (already added to
  // `pcbAdditionalRemuneration` above), so PCB's *regular* wage
  // excludes OT — the OT-derived tax lands in PCB(C) via the AR
  // formula, not in PCB(B). Category metadata controls whether each
  // fixed adjustment participates in each base.
  const epfWage = round2(Math.max(0, proratedPay + epfAdjustmentBase))
  const socsoWage = round2(
    Math.max(0, proratedPay + otPay + socsoAdjustmentBase),
  )
  const eisWage = round2(Math.max(0, proratedPay + otPay + eisAdjustmentBase))
  const pcbWage = round2(Math.max(0, proratedPay + pcbAdjustmentBase))

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
  // KWSP cliff (13→12 for Part A) is driven by the regular monthly
  // wage, NOT the combined wage with bonus. So we hand calcEpf the
  // regular EPF wage (combined minus the AR-flagged bonus portion)
  // as `rateDeterminingWage`. For employees whose bonus line was
  // ticked "Treat as regular monthly", `arEpfAmountForPcbKt` stays 0,
  // so the regular wage equals the combined wage and the strict
  // cliff applies — same behaviour as before this change.
  const regularEpfWageForRate = round2(
    Math.max(0, epfWage - arEpfAmountForPcbKt),
  )
  const epf = calcEpf({
    wage: epfWage,
    additionalRemuneration: arEpfBase,
    rateDeterminingWage: regularEpfWageForRate,
    employeeRate,
    employeeVoluntary: profile.epfEmployeeVoluntary,
    employerVoluntary: profile.epfEmployerVoluntary,
    contributeToEpf: profile.contributeToEpf,
    isMalaysianCitizen,
    hasPr: profile.hasPr,
    epfMemberBefore1998: profile.epfMemberBefore1998,
    ageAtPeriodEnd,
  })

  // Derive the LHDN PCB form's Kt as a band difference, so K1 + Kt
  // reconciles exactly to the EPF actually deducted (epf.employee)
  // even after the band tier jumps when bonus combines into wage.
  //
  //   K1 = band(regular wage only) — what would be deducted in a
  //        no-bonus month, displayed as PCB(A) on the LHDN form.
  //   Kt = epf.employee − band(regular wage only) — the marginal
  //        EPF the bonus tacked on top, displayed as Kt on the form.
  //
  // Pre-fix, Kt was computed as `ceil(bonus × rate / 100)` (e.g. 134
  // for Kay Ben's 1,218 bonus). That works when the bonus doesn't
  // push the combined wage across a band tier boundary, but
  // misattributes the tier-jump portion to K1 when it does — Kay Ben
  // was showing K1 = 460 instead of 451 because the 9-RM band jump
  // (from 4,100 → 5,400 upper) landed in the K1 bucket.
  let pcbAdditionalRemunerationEpf = 0
  if (arEpfAmountForPcbKt > 0) {
    const regularEpfWage = round2(
      Math.max(0, epfWage - arEpfAmountForPcbKt),
    )
    const epfRegularOnly = calcEpf({
      wage: regularEpfWage,
      additionalRemuneration: 0,
      employeeRate,
      employeeVoluntary: profile.epfEmployeeVoluntary,
      employerVoluntary: profile.epfEmployerVoluntary,
      contributeToEpf: profile.contributeToEpf,
      isMalaysianCitizen,
      hasPr: profile.hasPr,
      epfMemberBefore1998: profile.epfMemberBefore1998,
      ageAtPeriodEnd,
    })
    pcbAdditionalRemunerationEpf = round2(
      Math.max(0, epf.employee - epfRegularOnly.employee),
    )
  }

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

  const pcbCalcInput = {
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
  }
  const pcbBreakdown = calcPcb(pcbCalcInput)
  // LHDN-style breakdown for the Detailed Calculations PDF. Mirrors
  // the calcPcb arithmetic but exposes each named LHDN variable so
  // the audit trail can show "P = ..., M = ..., R = ..., etc.".
  const pcbCalculation = calcPcbBreakdown(pcbCalcInput)
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
  // Gross = prorated + OT + allowances + reimbursements, minus any
  // gross-reducing deductions (lost earnings, e.g. unpaid leave). The
  // base-salary line still shows the full salary; unpaid leave appears
  // as a separate "−X" line and is reflected here in gross.
  const grossPay = round2(
    proratedPay +
      otPay +
      totalAllowances +
      totalReimbursements -
      totalGrossReducingDeductions,
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
    pcbCalculation,
    pcbBreakdown: {
      normal: pcbBreakdown.normal,
      additional: pcbBreakdown.additional,
    },
    lineItems,
    epfRatesSnapshot: epfSnapshotRates({
      branch: epf.branch,
      profileEmployeeRate: employeeRate,
      wage: epfWage,
      arWage: arEpfBase,
      rateDeterminingWage: regularEpfWageForRate,
      voluntaryEmployee: profile.epfEmployeeVoluntary,
      voluntaryEmployer: profile.epfEmployerVoluntary,
      totalEmployee: epf.employee,
      totalEmployer: epf.employer,
    }),
    statutoryWarnings,
  }
}

/**
 * Snapshot rates + amounts by KWSP branch. The numbers stored on the
 * payslip reflect what the calc actually applied, not the profile's
 * declared rate (which the engine overrides for non-Part-A branches).
 *
 * Stores both the percentages and the RM amounts split into mandatory
 * vs voluntary on each side. The amounts let the Detailed Calculations
 * PDF render mandatory and voluntary as separate lines without having
 * to redo the math from the totals. Voluntary AMOUNT is computed from
 * the TOTAL EPF-able wage (regular + AR), matching how `calcEpf`
 * applies it.
 */
function epfSnapshotRates(input: {
  branch: EpfBranch
  profileEmployeeRate: number
  wage: number
  arWage: number
  /// Same semantics as `CalcEpfInput.rateDeterminingWage` — the regular
  /// monthly EPF-able wage that drives the RM 5,000 cliff. Defaults to
  /// `wage` (back-compat with callers that don't split bonus out).
  rateDeterminingWage?: number
  voluntaryEmployee: number
  voluntaryEmployer: number
  totalEmployee: number
  totalEmployer: number
}): PayslipEpfRatesSnapshot {
  let employee = 0
  let employer = 0
  const rateWage = input.rateDeterminingWage ?? input.wage
  switch (input.branch) {
    case "MALAYSIAN_UNDER_60":
      // Mirror the floor enforced in calcEpf: minimum statutory
      // employee share is 11%. Snapshot what the calc actually used.
      employee = Math.max(11, input.profileEmployeeRate)
      employer = rateWage <= 5000 ? 13 : 12
      break
    case "MALAYSIAN_CITIZEN_60_PLUS":
      employee = 0
      employer = 4
      break
    case "PR_OR_PRE1998_60_PLUS":
      employee = 5.5
      employer = rateWage <= 5000 ? 6.5 : 6
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

  // Voluntary amount uses the TOTAL EPF-able wage (regular + AR),
  // matching the formula in calcEpf — which ceils each side to the
  // next ringgit per KWSP convention. Mandatory amount = total -
  // voluntary for each side. For OPTED_OUT / DE_MINIMIS branches both
  // totals are 0, so the splits are also 0.
  const totalWage = input.wage + input.arWage
  const voluntaryAmountEmployee =
    input.voluntaryEmployee > 0
      ? Math.ceil(totalWage * input.voluntaryEmployee / 100)
      : 0
  const voluntaryAmountEmployer =
    input.voluntaryEmployer > 0
      ? Math.ceil(totalWage * input.voluntaryEmployer / 100)
      : 0
  const mandatoryAmountEmployee = round2(
    input.totalEmployee - voluntaryAmountEmployee,
  )
  const mandatoryAmountEmployer = round2(
    input.totalEmployer - voluntaryAmountEmployer,
  )

  return {
    employee,
    employer,
    voluntaryEmployee: input.voluntaryEmployee,
    voluntaryEmployer: input.voluntaryEmployer,
    mandatoryAmountEmployee,
    mandatoryAmountEmployer,
    voluntaryAmountEmployee,
    voluntaryAmountEmployer,
  }
}

/**
 * Convert attendance/leave minutes into the worked/expected hours shown
 * on the run table and payslip. DISPLAY ONLY — these figures do NOT feed
 * the pay calculation (`calcPayslip` prorates by working days, not by
 * attendance).
 *
 * `workedHours` = actual clocked hours (attended `durationMin` / 60), for
 * BOTH worker types — paid leave is NOT added (the HRS column shows hours
 * actually worked). `expectedHours` (MONTHLY only) = scheduled − paid
 * leave; HOURLY has no expected basis.
 */
export function autoHoursFromMinutes(input: {
  salaryType: SalaryType
  workedMin: number
  scheduledMin: number
  paidLeaveMin: number
}): { workedHours: number | null; expectedHours: number | null } {
  const workedHours = input.workedMin / 60
  if (input.salaryType === "MONTHLY") {
    return {
      workedHours,
      expectedHours: Math.max(0, input.scheduledMin - input.paidLeaveMin) / 60,
    }
  }
  return { workedHours, expectedHours: null }
}

/**
 * HRS percentage for MONTHLY staff: `workedHours / expectedHours` capped
 * at 100 and rounded to 2dp. Null when there's no hours basis (expected
 * missing/0 or worked unknown). Shared by the calc result and the run
 * table so both display the same figure.
 */
export function attendancePercentOf(
  workedHours: number | null | undefined,
  expectedHours: number | null | undefined,
): number | null {
  if (workedHours == null || expectedHours == null || expectedHours <= 0) {
    return null
  }
  return round2(Math.min(1, workedHours / expectedHours) * 100)
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
