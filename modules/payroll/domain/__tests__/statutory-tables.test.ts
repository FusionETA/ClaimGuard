import { describe, expect, it } from "vitest"

import {
  EIS_TABLE,
  SOCSO_TABLE,
  lookupEis,
  lookupEpfBand,
  lookupSocso,
} from "../statutory-tables"

/**
 * Snapshot the gazetted Third Schedule values at a handful of wage
 * points. If these fail, either the schedule has changed (download
 * the latest from KWSP / PERKESO) or the table file has been edited
 * incorrectly. Either way, do NOT silently update the snapshot —
 * cross-check against the source PDF first.
 */

// ─── SOCSO Act 4 ────────────────────────────────────────────────────────

describe("SOCSO Act 4 table", () => {
  it("has 65 rows", () => {
    expect(SOCSO_TABLE.length).toBe(65)
  })

  it("rows are sorted by upTo (strictly increasing)", () => {
    for (let i = 1; i < SOCSO_TABLE.length; i++) {
      expect(SOCSO_TABLE[i].upTo).toBeGreaterThan(SOCSO_TABLE[i - 1].upTo)
    }
  })

  it("only the last row is the ceiling (upTo = Infinity)", () => {
    const infiniteRows = SOCSO_TABLE.filter(
      (r) => !Number.isFinite(r.upTo),
    ).length
    expect(infiniteRows).toBe(1)
    expect(Number.isFinite(SOCSO_TABLE[SOCSO_TABLE.length - 1].upTo)).toBe(false)
  })

  it("row 1 (wages up to RM 30) — Cat 1: 40c / 10c, Cat 2: 30c", () => {
    expect(lookupSocso(25, false)).toEqual({ employer: 0.4, employee: 0.1 })
    expect(lookupSocso(25, true)).toEqual({ employer: 0.3, employee: 0 })
  })

  it("row 65 (ceiling, wages > RM 6,000) — Cat 1: 104.15 / 29.75, Cat 2: 74.40", () => {
    expect(lookupSocso(10_000, false)).toEqual({
      employer: 104.15,
      employee: 29.75,
    })
    expect(lookupSocso(6_000.01, true)).toEqual({ employer: 74.4, employee: 0 })
  })

  it("at the RM 6,000 ceiling exactly — same as row 64", () => {
    expect(lookupSocso(6_000, false)).toEqual({
      employer: 104.15,
      employee: 29.75,
    })
  })
})

// ─── EIS Act 800 ────────────────────────────────────────────────────────

describe("EIS Act 800 table", () => {
  it("has 65 rows", () => {
    expect(EIS_TABLE.length).toBe(65)
  })

  it("rows are sorted by upTo (strictly increasing)", () => {
    for (let i = 1; i < EIS_TABLE.length; i++) {
      expect(EIS_TABLE[i].upTo).toBeGreaterThan(EIS_TABLE[i - 1].upTo)
    }
  })

  it("only the last row is the ceiling (upTo = Infinity)", () => {
    const infiniteRows = EIS_TABLE.filter(
      (r) => !Number.isFinite(r.upTo),
    ).length
    expect(infiniteRows).toBe(1)
    expect(Number.isFinite(EIS_TABLE[EIS_TABLE.length - 1].upTo)).toBe(false)
  })

  it("row 1 (wages up to RM 30) — 5 sen each side", () => {
    expect(lookupEis(25)).toEqual({ employer: 0.05, employee: 0.05 })
  })

  it("row 65 (ceiling, wages > RM 6,000) — RM 11.90 each side", () => {
    expect(lookupEis(10_000)).toEqual({ employer: 11.9, employee: 11.9 })
  })
})

// ─── KWSP Third Schedule rule (Parts A, C, E, F) ────────────────────────

describe("EPF Third Schedule rule (lookupEpfBand)", () => {
  // Part A — Malaysian/PR/pre-1998, under 60: 13/12% employer + 11% employee
  it("Part A — wage RM 100 → employer RM 13, employee RM 11 (rounded up at upper band)", () => {
    expect(
      lookupEpfBand({
        wage: 100,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 13, employee: 11 })
  })

  it("Part A — wage RM 120 (middle of band 100.01-120) → employer RM 16, employee RM 14", () => {
    expect(
      lookupEpfBand({
        wage: 120,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 16, employee: 14 })
  })

  it("Part A — wage RM 5,000 (last RM 20 band) → employer RM 650, employee RM 550", () => {
    expect(
      lookupEpfBand({
        wage: 5000,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 650, employee: 550 })
  })

  it("Part A — wage RM 5,001 (first RM 100 band, rate switch to 12%) → employer RM 612, employee RM 561", () => {
    // upperBand = ceil(5001/100)*100 = 5100; employer = ceil(12% × 5100) = 612; employee = ceil(11% × 5100) = 561
    expect(
      lookupEpfBand({
        wage: 5001,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 612, employee: 561 })
  })

  it("Part A — wage RM 20,000 (last table row) → employer RM 2,400, employee RM 2,200", () => {
    expect(
      lookupEpfBand({
        wage: 20000,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 2400, employee: 2200 })
  })

  it("Part A — wage RM 25,750 (above table cap) → exact percentage, each side rounded up to next ringgit", () => {
    // employer = ceil(12% × 25750) = ceil(3090.00) = 3090; employee = ceil(11% × 25750) = ceil(2832.50) = 2833
    expect(
      lookupEpfBand({
        wage: 25750,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 3090, employee: 2833 })
  })

  it("Part A — wage ≤ RM 10 (DE_MINIMIS) → 0 / 0", () => {
    expect(
      lookupEpfBand({
        wage: 9.99,
        employerRateLow: 13,
        employerRateHigh: 12,
        employeeRate: 11,
      }),
    ).toEqual({ employer: 0, employee: 0 })
  })

  // Part C — PR / pre-1998 non-MY at 60+: 6.5/6% employer + 5.5% employee
  it("Part C — wage RM 100 → employer RM 7, employee RM 6", () => {
    // upperBand = 100. employer = ceil(6.5% × 100) = ceil(6.5) = 7; employee = ceil(5.5% × 100) = ceil(5.5) = 6
    expect(
      lookupEpfBand({
        wage: 100,
        employerRateLow: 6.5,
        employerRateHigh: 6,
        employeeRate: 5.5,
      }),
    ).toEqual({ employer: 7, employee: 6 })
  })

  // Part E — Malaysian citizen 60+: 0% employee, 4% employer flat
  it("Part E — Malaysian 60+, wage RM 5,500 → employer RM 220 (4% × ceil-band 5,500), employee RM 0", () => {
    // wage between 5,000 and 20,000 → RM 100 band. upper = ceil(5500/100)*100 = 5500. employer = ceil(4% × 5500) = 220
    expect(
      lookupEpfBand({
        wage: 5500,
        employerRateLow: 4,
        employerRateHigh: 4,
        employeeRate: 0,
      }),
    ).toEqual({ employer: 220, employee: 0 })
  })

  // Part F — post-1998 non-MY: 2% / 2% flat across all wages
  it("Part F — wage RM 8,000 → 2% × ceil-band 8,000 = RM 160 each side", () => {
    expect(
      lookupEpfBand({
        wage: 8000,
        employerRateLow: 2,
        employerRateHigh: 2,
        employeeRate: 2,
      }),
    ).toEqual({ employer: 160, employee: 160 })
  })
})
