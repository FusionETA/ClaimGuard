import { describe, expect, it } from "vitest"

import {
  availableDaysFor,
  initialProRatedAccrual,
} from "../accrual"

const d = (iso: string) => new Date(iso)

describe("initialProRatedAccrual", () => {
  // Regression for the Virtual.io / employee "v1" bug: entitledDays
  // changed to 14, PRO_RATED, joined 2026-01-01. As-of June the
  // join-date-aware accrual must be 6 months × 14/12 = 7 — NOT the
  // stale capped value the edit path used to leave behind.
  it("joined Jan 1 of the target year accrues a full month per elapsed month", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2026-01-01T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-06-29T00:00:00Z"),
      }),
    ).toBeCloseTo(7, 5)
  })

  it("caps at entitledDays once the whole year has elapsed", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2026-01-01T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-12-31T00:00:00Z"),
      }),
    ).toBeCloseTo(14, 5)
  })

  // Docstring example 1: mid-month join, same month.
  it("credits a partial join-month chunk only", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2026-02-11T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-02-20T00:00:00Z"),
      }),
    ).toBeCloseTo((18 / 28) * (14 / 12), 5) // 0.75
  })

  // Docstring example 2: one boundary crossed + partial join month.
  it("adds one full-month chunk after the next month boundary", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2026-02-11T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-03-05T00:00:00Z"),
      }),
    ).toBeCloseTo(14 / 12 + (18 / 28) * (14 / 12), 5) // 1.92
  })

  // Docstring example 3: joined a prior year → treated as full Jan start.
  it("treats a prior-year hire as a full January start", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2025-08-01T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-04-04T00:00:00Z"),
      }),
    ).toBeCloseTo(4 * (14 / 12), 5) // 4.67
  })

  // Docstring example 4: hire month is later this year than `now` →
  // the employee has not started yet, so accrual must be 0.
  it("returns 0 when the hire month is later in the year than now", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2026-09-01T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-04-04T00:00:00Z"),
      }),
    ).toBeCloseTo(0, 5)
  })

  it("returns 0 for a future-year hire", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 14,
        joinDate: d("2027-01-01T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-06-29T00:00:00Z"),
      }),
    ).toBe(0)
  })

  it("returns 0 when entitledDays is 0", () => {
    expect(
      initialProRatedAccrual({
        entitledDays: 0,
        joinDate: d("2026-01-01T00:00:00Z"),
        targetYear: 2026,
        now: d("2026-06-29T00:00:00Z"),
      }),
    ).toBe(0)
  })
})

describe("availableDaysFor", () => {
  it("PRO_RATED availability is driven by accruedDays, not entitledDays", () => {
    expect(
      availableDaysFor({
        accrualMethod: "PRO_RATED",
        entitledDays: 14,
        accruedDays: 7,
        carriedDays: 0,
        carriedExpired: false,
        usedDays: 0,
      }),
    ).toBe(7)
  })

  it("LUMP_SUM availability is driven by entitledDays", () => {
    expect(
      availableDaysFor({
        accrualMethod: "LUMP_SUM",
        entitledDays: 14,
        accruedDays: 7,
        carriedDays: 0,
        carriedExpired: false,
        usedDays: 0,
      }),
    ).toBe(14)
  })
})
