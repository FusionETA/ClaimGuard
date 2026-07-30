import { describe, expect, it } from "vitest"

import {
  computeSalaryChangeHint,
  type ComputeSalaryChangeHintInput,
} from "../salary-change-hint"
import type { SalaryChangeData } from "../salary-change"

/**
 * Mid-cycle salary-change proration.
 *
 * The delta is a CALENDAR proportion of the salary difference: a raise
 * mid-month means the person worked the whole month at two rates, so
 * the over/under-payment is `(new − old) × wrongSideDays / calendarDays`
 * — never the 26-day basis (that's for incomplete-WORK proration of
 * joiners/leavers). The regression these tests lock: the day-split
 * numerator and the divisor must use the SAME basis, so the two
 * day-counts always sum to the divisor.
 */

function makeChange(over: Partial<SalaryChangeData> = {}): SalaryChangeData {
  return {
    id: "sc_1",
    employeeProfileId: "ep_1",
    effectiveDate: "2026-07-20",
    previousSalaryType: "MONTHLY",
    previousMonthlySalary: 4000,
    previousHourlyRate: null,
    newSalaryType: "MONTHLY",
    newMonthlySalary: 4500,
    newHourlyRate: null,
    reason: "RAISE",
    notes: null,
    changedByUserId: null,
    changedByName: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    ...over,
  }
}

function baseInput(
  over: Partial<ComputeSalaryChangeHintInput> = {},
): ComputeSalaryChangeHintInput {
  return {
    payslipId: "ps_1",
    employeeProfileId: "ep_1",
    employeeName: "Muqris",
    payslipSnapshotMonthlySalary: 4500, // paid new rate all month → OVERPAID
    salaryChange: makeChange(),
    reasonLabel: "Raise",
    periodYear: 2026,
    periodMonth: 7, // July, 31 calendar days
    prorationRule: "TWENTY_SIX",
    existingManualLineLabels: [],
    ...over,
  }
}

describe("computeSalaryChangeHint — calendar-day proration", () => {
  it("day-counts always sum to the calendar divisor, even for TWENTY_SIX orgs", () => {
    const hint = computeSalaryChangeHint(baseInput({ prorationRule: "TWENTY_SIX" }))!
    // July, effective the 20th → 19 old-rate days + 12 new-rate days = 31.
    expect(hint.totalDaysInPeriod).toBe(31)
    expect(hint.daysAtOldRate).toBe(19)
    expect(hint.daysAtNewRate).toBe(12)
    expect(hint.daysAtOldRate + hint.daysAtNewRate).toBe(hint.totalDaysInPeriod)
  })

  it("OVERPAID delta = (new − old) × preChangeDays / calendarDays", () => {
    const hint = computeSalaryChangeHint(baseInput())!
    expect(hint.scenario).toBe("OVERPAID")
    // 500 × 19 / 31 = 306.4516… → 306.45. NOT 500 × 19/26 = 365.38.
    expect(hint.delta).toBe(306.45)
    expect(hint.suggestedLineItem?.kind).toBe("DEDUCTION")
    expect(hint.suggestedLineItem?.amount).toBe(306.45)
  })

  it("TWENTY_SIX and CALENDAR orgs get the SAME delta (rule doesn't change the divisor)", () => {
    const twentySix = computeSalaryChangeHint(
      baseInput({ prorationRule: "TWENTY_SIX" }),
    )!
    const calendar = computeSalaryChangeHint(
      baseInput({ prorationRule: "CALENDAR" }),
    )!
    expect(twentySix.delta).toBe(calendar.delta)
    expect(twentySix.totalDaysInPeriod).toBe(calendar.totalDaysInPeriod)
  })

  it("UNDERPAID delta = (new − old) × postChangeDays / calendarDays", () => {
    const hint = computeSalaryChangeHint(
      baseInput({ payslipSnapshotMonthlySalary: 4000 }), // paid old rate all month
    )!
    expect(hint.scenario).toBe("UNDERPAID")
    // 500 × 12 / 31 = 193.5483… → 193.55.
    expect(hint.delta).toBe(193.55)
    expect(hint.suggestedLineItem?.kind).toBe("ALLOWANCE")
  })

  it("effective on day 1 → MATCHED, no delta", () => {
    const hint = computeSalaryChangeHint(
      baseInput({
        salaryChange: makeChange({ effectiveDate: "2026-07-01" }),
      }),
    )!
    expect(hint.scenario).toBe("MATCHED")
    expect(hint.delta).toBe(0)
  })
})
