import { describe, expect, it } from "vitest"

import {
  DEFAULT_LUNCH_BREAK_MIN,
  expectedMinutesForRange,
  formatHoursOfTarget,
  parseWorkingDays,
  standardDailyMinutesFrom,
} from "@/modules/attendance/domain/hours-summary"

const MON_TO_FRI = parseWorkingDays("1,2,3,4,5")

function utcDate(iso: string): Date {
  // iso like "2026-05-11"
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

describe("standardDailyMinutesFrom", () => {
  it("subtracts the lunch break from the working span", () => {
    // 9 hours raw - 60 min lunch = 8 hours
    expect(standardDailyMinutesFrom("09:00", "18:00", 60)).toBe(8 * 60)
  })

  it("defaults to a 60-minute lunch when omitted", () => {
    expect(standardDailyMinutesFrom("09:00", "18:00")).toBe(8 * 60)
  })

  it("supports custom lunch break (90 min)", () => {
    // 9 hours raw - 90 min lunch = 7.5 hours
    expect(standardDailyMinutesFrom("09:00", "18:00", 90)).toBe(7 * 60 + 30)
  })

  it("clamps to zero when lunch consumes the whole span", () => {
    expect(standardDailyMinutesFrom("09:00", "10:00", 90)).toBe(0)
  })

  it("falls back to the system default when times are invalid", () => {
    expect(standardDailyMinutesFrom(null, "18:00")).toBe(8 * 60)
    expect(standardDailyMinutesFrom("18:00", "09:00")).toBe(8 * 60)
  })

  it("treats null lunch as the default", () => {
    expect(standardDailyMinutesFrom("09:00", "18:00", null)).toBe(8 * 60)
    expect(DEFAULT_LUNCH_BREAK_MIN).toBe(60)
  })
})

describe("expectedMinutesForRange", () => {
  // 2026-05-11 (Mon) .. 2026-05-17 (Sun) is a full ISO week.
  const monday = utcDate("2026-05-11")
  const sunday = utcDate("2026-05-17")

  it("counts 5 working days for a full Mon-Sun week with M-F schedule", () => {
    const minutes = expectedMinutesForRange({
      from: monday,
      to: sunday,
      workingDays: MON_TO_FRI,
      standardDailyMin: 8 * 60,
    })
    expect(minutes).toBe(5 * 8 * 60) // 2400 min = 40h
  })

  it("returns 0 for a weekend-only range with M-F schedule", () => {
    const sat = utcDate("2026-05-16")
    const sun = utcDate("2026-05-17")
    expect(
      expectedMinutesForRange({
        from: sat,
        to: sun,
        workingDays: MON_TO_FRI,
        standardDailyMin: 8 * 60,
      }),
    ).toBe(0)
  })

  it("counts partial weeks correctly", () => {
    // Mon-Wed = 3 working days
    const minutes = expectedMinutesForRange({
      from: monday,
      to: utcDate("2026-05-13"),
      workingDays: MON_TO_FRI,
      standardDailyMin: 8 * 60,
    })
    expect(minutes).toBe(3 * 8 * 60)
  })

  it("applies lunch break reduction via the daily minutes argument", () => {
    // Same full week but daily = 7.5h (90-min lunch)
    const dailyMin = standardDailyMinutesFrom("09:00", "18:00", 90)
    const minutes = expectedMinutesForRange({
      from: monday,
      to: sunday,
      workingDays: MON_TO_FRI,
      standardDailyMin: dailyMin,
    })
    expect(minutes).toBe(5 * (7 * 60 + 30)) // 5 * 7.5h
  })

  it("returns 0 when end is before start", () => {
    expect(
      expectedMinutesForRange({
        from: sunday,
        to: monday,
        workingDays: MON_TO_FRI,
        standardDailyMin: 8 * 60,
      }),
    ).toBe(0)
  })

  it("respects 6-day workweeks (Mon-Sat)", () => {
    const minutes = expectedMinutesForRange({
      from: monday,
      to: sunday,
      workingDays: parseWorkingDays("1,2,3,4,5,6"),
      standardDailyMin: 8 * 60,
    })
    expect(minutes).toBe(6 * 8 * 60)
  })
})

describe("formatHoursOfTarget", () => {
  it("renders whole-hour actuals without minutes", () => {
    expect(formatHoursOfTarget(26 * 60, 40 * 60)).toBe("26h / 40h")
  })

  it("includes minutes when the actual has remainder", () => {
    expect(formatHoursOfTarget(26 * 60 + 30, 40 * 60)).toBe("26h 30m / 40h")
  })

  it("treats negative inputs as zero", () => {
    expect(formatHoursOfTarget(-5, -120)).toBe("0h / 0h")
  })
})
