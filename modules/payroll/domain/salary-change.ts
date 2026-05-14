/**
 * Domain types for legitimate salary changes (raises, promotions,
 * demotions, restructures). Typo corrections are intentionally NOT
 * modelled here — they bypass this trail entirely.
 *
 * The data is captured for:
 *   - LHDN / SOCSO / EIS audit responses
 *   - Industrial Relations disputes
 *   - Retrenchment / VSS payouts ("last drawn salary")
 *   - HR year-end performance reviews
 *   - Employer-issued salary-history letters (loans, EPF/income proof)
 */

import type { SalaryType } from "@/modules/payroll/domain/models"

export const SALARY_CHANGE_REASONS = [
  "RAISE",
  "PROMOTION",
  "DEMOTION",
  "RESTRUCTURE",
  "OTHER",
] as const
export type SalaryChangeReason = (typeof SALARY_CHANGE_REASONS)[number]

export const SALARY_CHANGE_REASON_LABELS: Record<SalaryChangeReason, string> = {
  RAISE: "Raise",
  PROMOTION: "Promotion",
  DEMOTION: "Demotion",
  RESTRUCTURE: "Restructure",
  OTHER: "Other",
}

/**
 * Projected view of a SalaryChange row after the repo flattens
 * Decimals + dates into JS-friendly values.
 */
export type SalaryChangeData = {
  id: string
  employeeProfileId: string

  /// ISO yyyy-mm-dd — the date the change takes effect.
  effectiveDate: string

  /// Snapshot of the salary BEFORE the change.
  previousSalaryType: SalaryType
  previousMonthlySalary: number | null
  previousHourlyRate: number | null

  /// New values AFTER the change.
  newSalaryType: SalaryType
  newMonthlySalary: number | null
  newHourlyRate: number | null

  reason: SalaryChangeReason
  notes: string | null

  /// Author of the change. `null` for legacy / system-generated rows.
  changedByUserId: string | null
  changedByName: string | null

  createdAt: string
}

/**
 * Compute the percentage change in monthly salary between the
 * previous and new values. Returns null when either side is missing
 * or zero (e.g. salary type switch). Two-decimal precision.
 */
export function computeRaisePercent(change: SalaryChangeData): number | null {
  if (
    change.previousSalaryType !== "MONTHLY" ||
    change.newSalaryType !== "MONTHLY"
  ) {
    return null
  }
  const prev = change.previousMonthlySalary ?? 0
  const next = change.newMonthlySalary ?? 0
  if (prev <= 0 || next <= 0) return null
  return Math.round(((next - prev) / prev) * 10_000) / 100
}
