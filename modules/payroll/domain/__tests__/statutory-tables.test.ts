import { describe, expect, it } from "vitest"

import {
  EIS_TABLE,
  SOCSO_TABLE,
  getSkbbkPhaseForPeriod,
  lookupEis,
  lookupEpfBand,
  lookupSkbbk,
  lookupSocso,
  recommendSocsoScheme,
  socsoSchemeNeedsManualChoice,
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

// ─── recommendSocsoScheme + socsoSchemeNeedsManualChoice ────────────────
//
// Citizenship branches matter post Oct-2025 PERKESO expansion: foreign
// workers now fall under SOCSO coverage in the same way Malaysians do,
// but the 55–59 first-time-registrant ambiguity only applies to legacy
// citizen members — foreign workers entering MY employment under the
// new rules are always new registrants, so the dropdown can auto-fill
// cleanly right through to age 60.

describe("recommendSocsoScheme — citizenship branches", () => {
  // Fixed reference date so calculateAge is deterministic against the
  // DOBs below. All test DOBs sit at age N when asOf is 2026-06-22.
  const asOf = new Date("2026-06-22T00:00:00Z")
  const dobAge40 = new Date("1986-01-01T00:00:00Z")
  const dobAge57 = new Date("1969-01-01T00:00:00Z")
  const dobAge65 = new Date("1961-01-01T00:00:00Z")

  it("Malaysian < 55 → Scheme 1", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge40, isMalaysianCitizen: true, asOf }),
    ).toBe("EMPLOYMENT_INJURY_INVALIDITY")
  })

  it("Malaysian 55–59 → null (ambiguous, manual pick required)", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge57, isMalaysianCitizen: true, asOf }),
    ).toBeNull()
  })

  it("Malaysian ≥ 60 → Scheme 2", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge65, isMalaysianCitizen: true, asOf }),
    ).toBe("EMPLOYMENT_INJURY_ONLY")
  })

  it("Non-Malaysian < 55 → Scheme 1", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge40, isMalaysianCitizen: false, asOf }),
    ).toBe("EMPLOYMENT_INJURY_INVALIDITY")
  })

  it("Non-Malaysian 55–59 → Scheme 1 (no first-time-registrant ambiguity)", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge57, isMalaysianCitizen: false, asOf }),
    ).toBe("EMPLOYMENT_INJURY_INVALIDITY")
  })

  it("Non-Malaysian ≥ 60 → Scheme 2 (age dominates)", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge65, isMalaysianCitizen: false, asOf }),
    ).toBe("EMPLOYMENT_INJURY_ONLY")
  })

  it("Unknown nationality 55–59 → null (defaults to Malaysian rule)", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: dobAge57, isMalaysianCitizen: null, asOf }),
    ).toBeNull()
  })

  it("Missing DOB → null regardless of nationality", () => {
    expect(
      recommendSocsoScheme({ dateOfBirth: null, isMalaysianCitizen: false, asOf }),
    ).toBeNull()
  })
})

describe("socsoSchemeNeedsManualChoice — citizenship branches", () => {
  const asOf = new Date("2026-06-22T00:00:00Z")
  const dobAge57 = new Date("1969-01-01T00:00:00Z")
  const dobAge40 = new Date("1986-01-01T00:00:00Z")
  const dobAge65 = new Date("1961-01-01T00:00:00Z")

  it("Malaysian 55–59 → manual choice needed", () => {
    expect(
      socsoSchemeNeedsManualChoice({
        dateOfBirth: dobAge57,
        isMalaysianCitizen: true,
        asOf,
      }),
    ).toBe(true)
  })

  it("Non-Malaysian 55–59 → no manual choice (auto-fills Scheme 1)", () => {
    expect(
      socsoSchemeNeedsManualChoice({
        dateOfBirth: dobAge57,
        isMalaysianCitizen: false,
        asOf,
      }),
    ).toBe(false)
  })

  it("Malaysian < 55 → no manual choice", () => {
    expect(
      socsoSchemeNeedsManualChoice({
        dateOfBirth: dobAge40,
        isMalaysianCitizen: true,
        asOf,
      }),
    ).toBe(false)
  })

  it("Malaysian ≥ 60 → no manual choice (auto-fills Scheme 2)", () => {
    expect(
      socsoSchemeNeedsManualChoice({
        dateOfBirth: dobAge65,
        isMalaysianCitizen: true,
        asOf,
      }),
    ).toBe(false)
  })

  it("Unknown nationality 55–59 → manual choice (conservative default)", () => {
    expect(
      socsoSchemeNeedsManualChoice({
        dateOfBirth: dobAge57,
        isMalaysianCitizen: null,
        asOf,
      }),
    ).toBe(true)
  })
})

// ─── SKBBK / Skim LINDUNG 24 Jam ────────────────────────────────────────
//
// Phase 1 rates: 0.75% employee, effective 1 Jun 2026. The 65 amounts
// in SOCSO_TABLE[].skbbk come directly from the PERKESO gazette
// "NewContributionRateIncludingSKBBK" PDF. Identical for Cat 1 and
// Cat 2 (PERKESO publishes one column for both).

describe("SKBBK gazette table snapshot", () => {
  it("Row 1 — wage ≤ 30 → SKBBK RM 0.20", () => {
    expect(SOCSO_TABLE[0]?.skbbk).toBe(0.20)
  })

  it("Row 5 — wage 100–140 → SKBBK RM 0.90 (formula 0.75% × 140 = 1.05 would be wrong)", () => {
    expect(SOCSO_TABLE[4]?.skbbk).toBe(0.90)
  })

  it("Row 18 — wage 1300–1400 → SKBBK RM 10.15", () => {
    expect(SOCSO_TABLE[17]?.skbbk).toBe(10.15)
  })

  it("Row 64 — wage 5900–6000 (last band before cap) → SKBBK RM 44.65", () => {
    expect(SOCSO_TABLE[63]?.skbbk).toBe(44.65)
  })

  it("Row 65 — wage > 6000 → SKBBK capped at RM 44.65", () => {
    expect(SOCSO_TABLE[64]?.skbbk).toBe(44.65)
  })
})

describe("lookupSkbbk — period + wage", () => {
  it("Pre-Jun 2026 → returns 0 regardless of wage", () => {
    expect(
      lookupSkbbk({ wage: 3000, periodYear: 2026, periodMonth: 5 }),
    ).toBe(0)
    expect(
      lookupSkbbk({ wage: 3000, periodYear: 2025, periodMonth: 12 }),
    ).toBe(0)
  })

  it("1 Jun 2026 → SKBBK active (phase 1 0.75%)", () => {
    expect(
      lookupSkbbk({ wage: 3000, periodYear: 2026, periodMonth: 6 }),
    ).toBe(22.15) // row 34 (upTo 3000)
  })

  it("Wage 0 / negative / NaN → 0 (defensive)", () => {
    expect(
      lookupSkbbk({ wage: 0, periodYear: 2026, periodMonth: 6 }),
    ).toBe(0)
    expect(
      lookupSkbbk({ wage: NaN, periodYear: 2026, periodMonth: 6 }),
    ).toBe(0)
  })

  it("Wage above RM 6,000 → cap (RM 44.65)", () => {
    expect(
      lookupSkbbk({ wage: 10000, periodYear: 2026, periodMonth: 6 }),
    ).toBe(44.65)
  })

  it("Boundary: wage exactly 5000 lands on band-54 (upTo 5000)", () => {
    expect(
      lookupSkbbk({ wage: 5000, periodYear: 2026, periodMonth: 6 }),
    ).toBe(SOCSO_TABLE[53]?.skbbk)
  })
})

describe("getSkbbkPhaseForPeriod", () => {
  it("Returns null before any phase starts", () => {
    expect(getSkbbkPhaseForPeriod(2026, 5)).toBeNull()
    expect(getSkbbkPhaseForPeriod(2020, 1)).toBeNull()
  })

  it("Returns phase 1 starting Jun 2026", () => {
    const p = getSkbbkPhaseForPeriod(2026, 6)
    expect(p).not.toBeNull()
    expect(p?.employeeRatePct).toBe(0.75)
    expect(p?.startYear).toBe(2026)
    expect(p?.startMonth).toBe(6)
  })

  it("Phase 1 stays active for future periods until phase 2 lands", () => {
    expect(getSkbbkPhaseForPeriod(2027, 1)?.employeeRatePct).toBe(0.75)
    expect(getSkbbkPhaseForPeriod(2099, 12)?.employeeRatePct).toBe(0.75)
  })
})
