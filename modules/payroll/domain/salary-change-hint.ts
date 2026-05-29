/**
 * Smart-hint logic for mid-cycle salary changes.
 *
 * Background — the calc engine reads `PayrollProfile.monthlySalary` at
 * run time and uses that single value for the whole month. If a salary
 * change took effect mid-month, the resulting payslip is off by the
 * pro-rated delta (over- or under-paid depending on whether admin saved
 * the new value before or after generating the run).
 *
 * Industry parity: the major Malaysian competitors (PayrollPanda,
 * HReasily, Talenox, Kakitangan) also don't auto-prorate raises — they
 * expect the admin to add a manual adjustment line. This helper
 * computes that delta + suggests the line item, so admin can apply it
 * with one click instead of doing the math.
 *
 * Pure module: no Prisma, no I/O. Easy to unit-test.
 */

import { calendarDaysInMonth } from "@/modules/payroll/domain/calc"
import type { SalaryChangeData } from "@/modules/payroll/domain/salary-change"
import type { ManualLineItem } from "@/modules/payroll/domain/runs"
import type { WorkingDaysRule } from "@/modules/payroll/domain/settings"

/**
 * Round to 2 decimal places using "round half away from zero" (the
 * convention Malaysian payslips use). Local copy to avoid circular
 * import with `calc.ts`.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * A scenario describes the relationship between the salary the
 * payslip was generated with and the new "should be" salary.
 *
 *   - OVERPAID: payslip used the NEW (higher) salary for the whole
 *     month, but the change only took effect part-way through. The
 *     delta is a DEDUCTION to claw back the over-payment for the
 *     pre-change days.
 *
 *   - UNDERPAID: payslip used the OLD (lower) salary for the whole
 *     month, but the new salary should have applied for the post-
 *     change days. The delta is an ALLOWANCE (arrears) for the
 *     under-payment.
 *
 *   - MATCHED: the change either took effect on day 1 of the period
 *     (no proration needed) or already had its adjustment line
 *     applied. No hint needed.
 *
 *   - UNKNOWN: the payslip's snapshot doesn't match either the old
 *     or new value (e.g. a different value got typed in between, or
 *     a hourly-monthly switch). Admin needs to resolve manually.
 */
export type SalaryChangeHintScenario =
  | "OVERPAID"
  | "UNDERPAID"
  | "MATCHED"
  | "UNKNOWN"

export type SalaryChangeHint = {
  // Identifiers (used by the apply action to look up the right rows)
  payslipId: string
  employeeProfileId: string
  employeeName: string
  salaryChangeId: string

  // Context — surfaced verbatim in the banner copy
  effectiveDate: string
  previousMonthlySalary: number
  newMonthlySalary: number
  reasonLabel: string
  /// Salary the payslip was actually generated against. Drives the
  /// scenario decision + lets the banner explain "today's payslip
  /// shows RM X but should be Y".
  payslipSnapshotMonthlySalary: number

  // Computation result
  scenario: SalaryChangeHintScenario
  prorationRule: WorkingDaysRule
  totalDaysInPeriod: number
  daysAtOldRate: number
  daysAtNewRate: number
  /// Always non-negative. Sign is implied by `scenario`:
  ///   OVERPAID  → deduct this amount
  ///   UNDERPAID → add this amount
  delta: number

  /// Ready-to-use line item for `PayrollRunAdjustment.manualLineItems`.
  /// Null when scenario is MATCHED or UNKNOWN.
  suggestedLineItem: ManualLineItem | null

  /// True when an adjustment line matching this hint's marker tag
  /// already exists on the payslip. The UI hides the banner in that
  /// case so admin isn't asked to apply twice.
  alreadyApplied: boolean
}

/**
 * Compute days at each rate for a single salary change against a
 * payroll period. Uses calendar days regardless of the proration rule
 * for the boundary calculation (e.g. May 15 is always day 15 of May,
 * whether the org pays based on calendar / 26-day / working days);
 * the proration rule controls the DIVISOR (total days), not the
 * before/after split.
 */
function computeDaySplit(input: {
  periodYear: number
  periodMonth: number
  effectiveDate: string
  prorationRule: WorkingDaysRule
}): {
  totalDaysInPeriod: number
  daysAtOldRate: number
  daysAtNewRate: number
} {
  const periodStart = Date.UTC(input.periodYear, input.periodMonth - 1, 1)
  const periodEnd = Date.UTC(
    input.periodYear,
    input.periodMonth - 1,
    calendarDaysInMonth(input.periodYear, input.periodMonth),
  )
  const effective = Date.parse(input.effectiveDate)

  // If effective is outside the period the helper shouldn't be called,
  // but defend anyway.
  if (
    Number.isNaN(effective) ||
    effective < periodStart ||
    effective > periodEnd
  ) {
    return {
      totalDaysInPeriod: calendarDaysInMonth(input.periodYear, input.periodMonth),
      daysAtOldRate: 0,
      daysAtNewRate: 0,
    }
  }

  const calendarDays = calendarDaysInMonth(input.periodYear, input.periodMonth)
  const effectiveDay = new Date(effective).getUTCDate()
  // Effective date INCLUSIVE on the new rate (i.e. effective 15 May
  // means May 15 itself is paid at the new rate).
  const daysAtOld = effectiveDay - 1
  const daysAtNew = calendarDays - daysAtOld

  // Total = days in month for CALENDAR rule, 26 for TWENTY_SIX. We use
  // calendar days for the split itself either way because LHDN proration
  // examples use calendar boundaries.
  const totalDaysInPeriod =
    input.prorationRule === "TWENTY_SIX" ? 26 : calendarDays

  return {
    totalDaysInPeriod,
    daysAtOldRate: daysAtOld,
    daysAtNewRate: daysAtNew,
  }
}

/**
 * Marker tag we embed in the suggested line item's `label` so the
 * banner can detect when an adjustment has already been applied (e.g.
 * after a page refresh) and stop showing the hint. Format is
 * deterministic so the matcher is exact.
 */
export function salaryChangeHintMarker(salaryChangeId: string): string {
  return `[salary-hint:${salaryChangeId}]`
}

export type ComputeSalaryChangeHintInput = {
  payslipId: string
  employeeProfileId: string
  employeeName: string
  payslipSnapshotMonthlySalary: number
  salaryChange: SalaryChangeData
  reasonLabel: string
  periodYear: number
  periodMonth: number
  prorationRule: WorkingDaysRule
  /// Existing adjustment lines on this run for this employee.
  /// Used to detect if the hint's adjustment has already been
  /// applied (avoids double-action after refresh).
  existingManualLineLabels: string[]
}

/**
 * Build the hint for one (salary-change, payslip) pair. Returns null
 * if the change doesn't apply (e.g. salary type switch — different
 * shape).
 */
export function computeSalaryChangeHint(
  input: ComputeSalaryChangeHintInput,
): SalaryChangeHint | null {
  const sc = input.salaryChange

  // Only MONTHLY → MONTHLY changes get proration math. Salary-type
  // switches (HOURLY → MONTHLY etc.) need bespoke handling we don't
  // model yet — surface as UNKNOWN so admin sees the change but does
  // their own math.
  if (
    sc.previousSalaryType !== "MONTHLY" ||
    sc.newSalaryType !== "MONTHLY" ||
    sc.previousMonthlySalary == null ||
    sc.newMonthlySalary == null
  ) {
    return null
  }

  const oldSalary = sc.previousMonthlySalary
  const newSalary = sc.newMonthlySalary
  if (oldSalary === newSalary) return null

  const split = computeDaySplit({
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
    effectiveDate: sc.effectiveDate,
    prorationRule: input.prorationRule,
  })

  // Effective date is day-1-of-period → no proration delta even though
  // the change is "inside" the run. Treat as MATCHED so the banner
  // doesn't nag.
  if (split.daysAtOldRate === 0) {
    return {
      payslipId: input.payslipId,
      employeeProfileId: input.employeeProfileId,
      employeeName: input.employeeName,
      salaryChangeId: sc.id,
      effectiveDate: sc.effectiveDate,
      previousMonthlySalary: oldSalary,
      newMonthlySalary: newSalary,
      reasonLabel: input.reasonLabel,
      payslipSnapshotMonthlySalary: input.payslipSnapshotMonthlySalary,
      scenario: "MATCHED",
      prorationRule: input.prorationRule,
      totalDaysInPeriod: split.totalDaysInPeriod,
      daysAtOldRate: split.daysAtOldRate,
      daysAtNewRate: split.daysAtNewRate,
      delta: 0,
      suggestedLineItem: null,
      alreadyApplied: false,
    }
  }

  const marker = salaryChangeHintMarker(sc.id)
  const alreadyApplied = input.existingManualLineLabels.some((l) =>
    l.includes(marker),
  )

  // Decide scenario by comparing the snapshot to the old/new values.
  // Small tolerance for floating-point compares (Decimal → number
  // can drift 1 cent on edge cases).
  const matchesNew = Math.abs(input.payslipSnapshotMonthlySalary - newSalary) < 0.01
  const matchesOld = Math.abs(input.payslipSnapshotMonthlySalary - oldSalary) < 0.01

  let scenario: SalaryChangeHintScenario
  let delta = 0
  let suggestedLineItem: ManualLineItem | null = null

  // For both scenarios the proration formula is the salary delta
  // times the wrong-side days over the total period days.
  const salaryDelta = newSalary - oldSalary

  if (matchesNew) {
    // Run paid the new (higher) rate the entire month → claw back
    // overpayment for the pre-change days.
    scenario = "OVERPAID"
    delta = round2(
      (salaryDelta * split.daysAtOldRate) / split.totalDaysInPeriod,
    )
    suggestedLineItem = {
      kind: "DEDUCTION",
      category: "deduct_salary_adjustment",
      label: buildLineLabel({
        scenario: "OVERPAID",
        effectiveDate: sc.effectiveDate,
        oldSalary,
        newSalary,
        salaryChangeId: sc.id,
      }),
      amount: delta,
    }
  } else if (matchesOld) {
    // Run paid the old (lower) rate the entire month → add arrears
    // for the post-change days.
    scenario = "UNDERPAID"
    delta = round2(
      (salaryDelta * split.daysAtNewRate) / split.totalDaysInPeriod,
    )
    suggestedLineItem = {
      kind: "ALLOWANCE",
      category: "wages_arrears",
      label: buildLineLabel({
        scenario: "UNDERPAID",
        effectiveDate: sc.effectiveDate,
        oldSalary,
        newSalary,
        salaryChangeId: sc.id,
      }),
      amount: delta,
    }
  } else {
    // Snapshot doesn't match either — typo, double change, or salary
    // got tweaked between generation and now. Surface but no auto-fix.
    scenario = "UNKNOWN"
  }

  return {
    payslipId: input.payslipId,
    employeeProfileId: input.employeeProfileId,
    employeeName: input.employeeName,
    salaryChangeId: sc.id,
    effectiveDate: sc.effectiveDate,
    previousMonthlySalary: oldSalary,
    newMonthlySalary: newSalary,
    reasonLabel: input.reasonLabel,
    payslipSnapshotMonthlySalary: input.payslipSnapshotMonthlySalary,
    scenario,
    prorationRule: input.prorationRule,
    totalDaysInPeriod: split.totalDaysInPeriod,
    daysAtOldRate: split.daysAtOldRate,
    daysAtNewRate: split.daysAtNewRate,
    delta: Math.abs(delta),
    suggestedLineItem: alreadyApplied ? null : suggestedLineItem,
    alreadyApplied,
  }
}

/**
 * Build the line-item label. Embeds the marker tag at the end so the
 * banner can detect already-applied hints; the human-readable prefix
 * is what shows up on payslips.
 */
function buildLineLabel(input: {
  scenario: "OVERPAID" | "UNDERPAID"
  effectiveDate: string
  oldSalary: number
  newSalary: number
  salaryChangeId: string
}): string {
  const direction = input.scenario === "OVERPAID" ? "deduct" : "arrears"
  return `Mid-cycle salary change ${direction} (effective ${input.effectiveDate}, ${input.oldSalary.toFixed(0)} → ${input.newSalary.toFixed(0)}) ${salaryChangeHintMarker(input.salaryChangeId)}`
}
