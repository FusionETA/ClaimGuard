import { describe, expect, it } from "vitest"

import {
  WEEKDAY_NAMES,
  invertWeekdayNames,
  isoDaysToWeekdayNames,
  weekdayNamesToCsv,
} from "@/lib/weekdays"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"

/**
 * These conversions feed `Organization.workingDays` / `XeroProject
 * .workingDays`, which the payroll engine reads to count working days
 * for proration and the unpaid-leave deduction. A wrong mapping here
 * silently mis-pays people, so the round-trip through the engine's own
 * `parseWorkingDays` is asserted rather than just the local functions.
 */
describe("weekdayNamesToCsv", () => {
  it("maps Mon–Fri to the ISO CSV the DB stores", () => {
    expect(
      weekdayNamesToCsv([
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
      ]),
    ).toBe("1,2,3,4,5")
  })

  it("maps a 6-day week", () => {
    expect(
      weekdayNamesToCsv([
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
      ]),
    ).toBe("1,2,3,4,5,6")
  })

  it("sorts Mon→Sun regardless of input order", () => {
    expect(weekdayNamesToCsv(["SUNDAY", "WEDNESDAY", "MONDAY"])).toBe("1,3,7")
  })

  it("de-duplicates repeated days", () => {
    expect(weekdayNamesToCsv(["MONDAY", "MONDAY", "TUESDAY"])).toBe("1,2")
  })

  it("returns an empty string for an empty list", () => {
    // Callers must reject this before writing — an empty working week
    // would zero the proration divisor. Asserted so the behaviour is
    // explicit rather than incidental.
    expect(weekdayNamesToCsv([])).toBe("")
  })
})

describe("isoDaysToWeekdayNames", () => {
  it("maps ISO numbers back to names in Mon→Sun order", () => {
    expect(isoDaysToWeekdayNames([7, 1, 3])).toEqual([
      "MONDAY",
      "WEDNESDAY",
      "SUNDAY",
    ])
  })

  it("drops out-of-range and duplicate values", () => {
    expect(isoDaysToWeekdayNames([0, 1, 1, 8, 5, -3])).toEqual([
      "MONDAY",
      "FRIDAY",
    ])
  })
})

describe("invertWeekdayNames", () => {
  it("returns the rest days for a Mon–Fri week", () => {
    expect(
      invertWeekdayNames([
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
      ]),
    ).toEqual(["SATURDAY", "SUNDAY"])
  })

  it("round-trips: inverting twice returns the original set", () => {
    const week = ["MONDAY", "WEDNESDAY", "FRIDAY"] as const
    expect(invertWeekdayNames(invertWeekdayNames(week))).toEqual([...week])
  })

  it("returns every day for an empty working week", () => {
    expect(invertWeekdayNames([])).toEqual([...WEEKDAY_NAMES])
  })
})

describe("round-trip through the engine's parseWorkingDays", () => {
  it("survives names → CSV → engine set → names for every subset size", () => {
    const cases: Array<readonly (typeof WEEKDAY_NAMES)[number][]> = [
      ["MONDAY"],
      ["SATURDAY", "SUNDAY"],
      ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
      ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"],
      [...WEEKDAY_NAMES],
    ]
    for (const names of cases) {
      const csv = weekdayNamesToCsv(names)
      expect(isoDaysToWeekdayNames(parseWorkingDays(csv))).toEqual([...names])
    }
  })

  it("reports Mon–Fri when the column is unset, matching the engine default", () => {
    // `parseWorkingDays(null)` falls back to Mon–Fri, so the API's
    // "effective working days" must report that rather than an empty
    // list — otherwise a partner reading an unconfigured org would
    // think nobody works.
    expect(isoDaysToWeekdayNames(parseWorkingDays(null))).toEqual([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
    ])
  })
})
