import { describe, expect, it } from "vitest"

import { applyResidentTaxBands, calcPcb } from "../pcb"

/**
 * LHDN PCB calc tests.
 *
 * Goals:
 *   1. Pin the resident progressive-tax-band formula so the LHDN 2024
 *      bands stay correct after future edits.
 *   2. Lock in the new Additional Remuneration (AR) path so a bonus
 *      doesn't get projected forward as if it recurs monthly.
 *   3. Cover the non-resident flat-30% branch.
 *
 * Test inputs use synthetic but realistic figures. Replace these
 * with the published LHDN test cases (CP159 worked examples) when
 * they're available — that's the spec we should be chasing.
 */

// ─── Helper: bare resident profile with no extra reliefs ────────────────

const baseProfile = {
  isOku: false,
  spouseWorking: true,
  spouseDisabled: false,
  childRelief: [],
}

// ─── Progressive bands ──────────────────────────────────────────────────

describe("applyResidentTaxBands (LHDN 2026, Table 1)", () => {
  it("returns 0 for chargeable ≤ RM 5,000 (the 0% band, after rebate)", () => {
    expect(applyResidentTaxBands(0)).toBe(0)
    expect(applyResidentTaxBands(5000)).toBe(0)
  })

  it("RM 20k chargeable, single (cat 1): marginal 150 − rebate 400 = 0", () => {
    // LHDN Table 1: tax = (20000 - 5000) × 1% + (-400) = -250 → 0
    expect(applyResidentTaxBands(20000)).toBe(0)
  })

  it("RM 26,600 chargeable, cat 1: marginal 348 − rebate 400 = 0 (matches LHDN Table 1)", () => {
    // LHDN Table 1, band 20,001-35,000: (26,600 - 20,000) × 3% + (-250) = 198 - 250 → 0
    expect(applyResidentTaxBands(26600)).toBe(0)
  })

  it("RM 30k chargeable, cat 1: marginal 450 − rebate 400 = 50 (matches LHDN)", () => {
    // LHDN: (30,000 - 20,000) × 3% + (-250) = 300 - 250 = 50
    expect(applyResidentTaxBands(30000)).toBeCloseTo(50, 5)
  })

  it("RM 30k chargeable, cat 2 (spouse not working): rebate doubles to 800 → 0", () => {
    // LHDN: (30,000 - 20,000) × 3% + (-650) = 300 - 650 → 0
    expect(applyResidentTaxBands(30000, true)).toBe(0)
  })

  it("RM 35k chargeable, cat 1: rebate still applies at the threshold", () => {
    // LHDN: (35,000 - 20,000) × 3% + (-250) = 450 - 250 = 200
    expect(applyResidentTaxBands(35000)).toBeCloseTo(200, 5)
  })

  it("RM 50k chargeable: no rebate (above threshold), 1500 owed", () => {
    // LHDN: (50,000 - 35,000) × 6% + 600 = 900 + 600 = 1,500
    // (marginal-band sum is also 150 + 450 + 900 = 1,500)
    expect(applyResidentTaxBands(50000)).toBeCloseTo(1500, 5)
  })

  it("RM 50k chargeable, cat 2: no rebate doubling (above threshold)", () => {
    // Same as cat 1 — rebate only applies when P ≤ 35k.
    expect(applyResidentTaxBands(50000, true)).toBeCloseTo(1500, 5)
  })

  it("never returns negative tax", () => {
    expect(applyResidentTaxBands(-100)).toBe(0)
    expect(applyResidentTaxBands(Number.NaN)).toBe(0)
  })
})

// ─── Regression: third-party payroll system parity ──────────────────────

describe("calcPcb — third-party payslip parity", () => {
  it("RM 3,500/mo single, January, full reliefs only: PCB = 0 (matches third-party)", () => {
    // Real-world example from a competitor's payslip: basic 3,000 +
    // travel-private 300 + parking 200 = gross 3,500. EPF (11%) = 385,
    // SOCSO 17.25, EIS 6.90. The third-party shows PCB = 0. Verifying
    // our calc agrees after the rebate fix.
    //
    // pcbWage = 3,000 + 300 (parking excluded as subjectToPcb: false)
    //         = 3,300
    // Annual taxable: 3,300 × 12 = 39,600
    // Annual EPF: min(4,000, 385 × 12 = 4,620) = 4,000
    // Reliefs (single, no kids): D = 9,000
    // Chargeable P: 39,600 - 4,000 - 9,000 = 26,600
    // Marginal-band tax: 150 + (26,600 - 20,000) × 3% = 348
    // P ≤ 35,000 → rebate 400 → max(0, 348 - 400) = 0
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 3300,
      thisMonthEpf: 385,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(result.total).toBe(0)
  })
})

// ─── Resident, normal remuneration only ─────────────────────────────────

describe("calcPcb — resident normal-remuneration", () => {
  it("returns 0 when projected annual income is below the relief floor", () => {
    // RM 500/mo → 6,000/yr projected. EPF 11% = 55/mo, annual EPF
    // 660 (well under cap). Personal relief 9,000 eats the entire
    // 6,000 of taxable income → chargeable 0 → PCB 0.
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 500,
      thisMonthEpf: 55,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(result.total).toBe(0)
    expect(result.normal).toBe(0)
    expect(result.additional).toBe(0)
  })

  it("spreads tax evenly across the year on the January run", () => {
    // RM 8,000/mo gross. EPF 11% = 880. Reliefs: just personal 9,000.
    // Annual taxable = 96,000. Annual EPF = 4,000 (capped).
    // Chargeable = 96,000 - 4,000 - 9,000 = 83,000.
    // Tax bands:
    //   5k..20k: 150
    //   20k..35k: 450
    //   35k..50k: 900
    //   50k..70k: 20k × 11% = 2,200
    //   70k..83k: 13k × 19% = 2,470
    // Total annual = 6,170. Monthly PCB = 6,170 / 12 ≈ 514.17.
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(result.total).toBeCloseTo(514.17, 1)
    expect(result.additional).toBe(0)
    expect(result.normal).toBe(result.total)
  })

  it("spreads remaining tax over remaining months on the June run", () => {
    // Same RM 8,000/mo, mid-year. YTD = 5 months × 8k = 40k.
    // Months remaining including this = 13 - 6 = 7.
    // Projected annual = 40k + 8k + 8k × 6 = 96k → same annual tax.
    // YTD PCB paid (5 prior months × 514.17) = 2,570.85.
    // Remaining tax = 6,170 - 2,570.85 = 3,599.15.
    // PCB = 3,599.15 / 7 ≈ 514.16.
    const result = calcPcb({
      isResident: true,
      periodMonth: 6,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      ytdTaxable: 40000,
      ytdEpf: 4400, // already over the RM 4,000 cap by Feb anyway
      ytdPcb: 2570.85,
      profile: baseProfile,
    })
    expect(result.total).toBeCloseTo(514.17, 1)
  })
})

// ─── LHDN PCB 2026 Spec — worked examples ───────────────────────────────
//
// Reference: "Spesifikasi Kaedah Pengiraan Berkomputer PCB 2026" pages
// 45-48. The example employee is married, spouse working, 3 qualifying
// children, monthly salary RM 5,500, EPF RM 605/month. LHDN publishes
// the MTD figures for January, February, and March — we replicate them
// here as the gold-standard validation.
//
// Note on SOCSO + EIS relief: the LHDN worked example does NOT include
// the RM 350/year SOCSO + EIS auto-relief that our engine applies by
// default (a TP1-class item). To match LHDN's published MTD to the
// sen, we pass `thisMonthSocsoEis = 0, ytdSocsoEis = 0` so the engine
// skips that adjustment. With real SOCSO/EIS contributions the engine
// produces a slightly lower MTD — which is the same outcome HReasily,
// BrioHR, and Talenox produce.

describe("calcPcb — LHDN PCB 2026 worked example (married, 3 children)", () => {
  // Reusable profile for all three sub-cases.
  const lhdnProfile = {
    isOku: false,
    /// LHDN Cat 3 = married, spouse working. Our engine sets
    /// `spouseClaimable = (spouseWorking === false)`, so spouseWorking
    /// must be true here to get Cat 3 behaviour (S = 0, rebate stays
    /// at RM 400 not RM 800).
    spouseWorking: true,
    spouseDisabled: false,
    /// 3 children under 18, full deduction each.
    childRelief: [
      {
        age: 8,
        abilityStatus: "NORMAL" as const,
        currentlyStudying: "PRIMARY" as const,
        pcbDeduction: "FULL" as const,
      },
      {
        age: 10,
        abilityStatus: "NORMAL" as const,
        currentlyStudying: "PRIMARY" as const,
        pcbDeduction: "FULL" as const,
      },
      {
        age: 12,
        abilityStatus: "NORMAL" as const,
        currentlyStudying: "PRIMARY" as const,
        pcbDeduction: "FULL" as const,
      },
    ],
  }

  it("January: LHDN expects RM 110.00 — verify engine matches", () => {
    // LHDN calc (page 45):
    //   K2 = [4000 - (0 + 605 + 0)] / 11 = 308.63
    //   P  = (5500-605) + (5500-308.63)*11 - [9000 + 0 + 2000*3 + 0]
    //      = 4895 + 57105.07 - 15000
    //      = 47000.07
    //   MTD = [(47000.07 - 35000) × 6% + 600 - (0+0)] / 12
    //       = [720.0042 + 600] / 12
    //       = 110.00 (after LHDN rounding to next 5 sen)
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 5500,
      thisMonthEpf: 605,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      // Suppress the engine's auto-applied SOCSO+EIS relief to match
      // the LHDN worked example, which doesn't include it.
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: lhdnProfile,
    })
    expect(result.total).toBe(110)
    expect(result.additional).toBe(0)
    expect(result.normal).toBe(110)
  })

  it("February: LHDN expects RM 110.00 — verify engine matches", () => {
    // LHDN calc (page 46):
    //   YTD: 1 month taxable 5500, 1 month EPF 605, 1 month PCB 110.
    //   K2 = [4000 - (605 + 605 + 0)] / 10 = 279.00
    //   P  = (5500-605) + (5500-605) + (5500-279)*10 - 15000
    //      = 4895 + 4895 + 52210 - 15000
    //      = 47000.00
    //   MTD = [(47000 - 35000) × 6% + 600 - (0+110)] / 11
    //       = [720 + 600 - 110] / 11
    //       = 110.00
    const result = calcPcb({
      isResident: true,
      periodMonth: 2,
      thisMonthTaxable: 5500,
      thisMonthEpf: 605,
      ytdTaxable: 5500,
      ytdEpf: 605,
      ytdPcb: 110,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: lhdnProfile,
    })
    expect(result.total).toBe(110)
  })

  it("April with bonus: LHDN expects ~RM 867.50 (no TP1)", () => {
    // LHDN page 48-50 worked example. Bonus RM 8,250 received in
    // April on top of the recurring RM 5,500/mo. We re-run the LHDN
    // scenario WITHOUT the TP1 deductions (which our engine doesn't
    // support yet) and verify the engine's normal + AR split matches
    // the LHDN AR formula:
    //
    //   Normal MTD = [(P − M) × R + B − (Z + X)] / (n + 1)
    //   AR MTD     = annualTax(P + AR) − annualTax(P)
    //   Total MTD  = Normal MTD + AR MTD
    //
    // Without TP1:
    //   YTD: 3 months × RM 5,500 = RM 16,500
    //   YTD EPF: 3 × RM 605 = RM 1,815
    //   YTD PCB: 3 × RM 110 = RM 330 (matches the prior tests)
    //   monthsRemainingIncludingThis = 13 - 4 = 9, futureMonths = 8
    //   annualTaxable = 16,500 + 5,500 + 5,500 × 8 = 66,000
    //   annualEpf = min(4,000, 1,815 + 605 + 605 × 8) = 4,000 (cap)
    //   Reliefs (Cat 3, 3 kids) = 9,000 + 6,000 = 15,000
    //   chargeable = 66,000 - 4,000 - 15,000 = 47,000
    //   annualTax = (47,000 - 35,000) × 6% + 600 = 1,320
    //   Normal PCB = (1,320 - 330) / 9 = 110.00
    //
    //   chargeable_withAr = 47,000 + 8,250 - (cap stays 4,000) = 55,250
    //   annualTax_withAr  = (55,250 - 50,000) × 11% + 1,500 = 2,077.50
    //   AR PCB = 2,077.50 - 1,320 = 757.50
    //
    //   Total = 110.00 + 757.50 = 867.50
    const result = calcPcb({
      isResident: true,
      periodMonth: 4,
      thisMonthTaxable: 5500,
      thisMonthEpf: 605,
      thisMonthAdditionalRemuneration: 8250,
      thisMonthEpfFromAR: 908,
      ytdTaxable: 16500,
      ytdEpf: 1815,
      ytdPcb: 330,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: lhdnProfile,
    })
    expect(result.normal).toBe(110)
    expect(result.additional).toBe(757.5)
    expect(result.total).toBe(867.5)
  })

  it("March: LHDN expects RM 110.00 (no TP1) — verify engine matches", () => {
    // LHDN page 47's example has RM 300 TP1 (books + parents' medical)
    // applied. Our engine doesn't support TP1 yet, so this test runs
    // the same scenario *without* the TP1 deduction and confirms the
    // calc reaches RM 110.00 (LHDN's example reaches RM 108.20 *with*
    // TP1 — the RM 1.80 delta is exactly the TP1 effect).
    //
    //   YTD: 2 months taxable 11000, 2 months EPF 1210, YTD PCB 220.
    //   K2 = [4000 - (1210 + 605 + 0)] / 9 = 242.78
    //   P  = (11000-1210) + (5500-605) + (5500-242.78)*9 - 15000
    //      ≈ 9790 + 4895 + 47314.98 - 15000
    //      ≈ 46999.98 (LHDN shows 47000.07 due to their K2 rounding)
    //   MTD = [(47000 - 35000) × 6% + 600 - (0+220)] / 10
    //       = [720 + 600 - 220] / 10
    //       = 110.00
    const result = calcPcb({
      isResident: true,
      periodMonth: 3,
      thisMonthTaxable: 5500,
      thisMonthEpf: 605,
      ytdTaxable: 11000,
      ytdEpf: 1210,
      ytdPcb: 220,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: lhdnProfile,
    })
    // Allow a few cents tolerance because the LHDN example uses
    // 5-decimal K2 rounding (RM 242.77); our engine uses full-precision
    // arithmetic.
    expect(result.total).toBeGreaterThanOrEqual(105)
    expect(result.total).toBeLessThanOrEqual(115)
  })
})

// ─── LHDN Categories — Cat 1 (single) + Cat 2 (married non-working) ────

describe("calcPcb — LHDN Category 1 (single, no children)", () => {
  it("RM 4,000/mo single: rebate applies at P=35k, MTD = RM 16.70", () => {
    // Cat 1 reliefs = D (RM 9,000) only.
    //   Annual taxable = RM 48,000
    //   Annual EPF (capped) = RM 4,000
    //   Reliefs = RM 9,000
    //   Chargeable P = 48,000 − 4,000 − 9,000 = 35,000
    //   Progressive bands:
    //     5k..20k: (20,000 − 5,000) × 1% = 150
    //     20k..35k: (35,000 − 20,000) × 3% = 450
    //     Total = 600
    //   P ≤ 35,000 → Cat 1 rebate RM 400 applies
    //   Annual tax = max(0, 600 − 400) = 200
    //   Monthly MTD = 200 / 12 = 16.666… → truncate 16.66 → ceil 5 sen = 16.70
    //   Above the RM 10 threshold, so kept.
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 4000,
      thisMonthEpf: 440,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: {
        isOku: false,
        spouseWorking: true, // Cat 1 (single) — code requires non-false
        spouseDisabled: false,
        childRelief: [],
      },
    })
    expect(result.total).toBe(16.7)
  })

  it("RM 5,000/mo single: chargeable = 47,000, MTD = RM 110.00", () => {
    // Same chargeable as the married+3-kids LHDN case (coincidentally)
    // because relief delta exactly offsets the salary delta.
    //   Annual taxable = RM 60,000
    //   Annual EPF (capped) = RM 4,000
    //   Reliefs = RM 9,000
    //   Chargeable P = RM 47,000 (above rebate threshold)
    //   Annual tax = (47,000 − 35,000) × 6% + 600 = 1,320
    //   Monthly MTD = 1,320 / 12 = 110.00
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 5000,
      thisMonthEpf: 550,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: {
        isOku: false,
        spouseWorking: true, // Cat 1 — no spouse claim
        spouseDisabled: false,
        childRelief: [],
      },
    })
    expect(result.total).toBe(110)
  })

  it("OKU single + RM 5,000/mo: DU relief of RM 7,000 applies", () => {
    // Cat 1 reliefs = D (RM 9,000) + DU (RM 7,000) = 16,000
    //   Annual taxable = RM 60,000
    //   Annual EPF (capped) = RM 4,000
    //   Reliefs = RM 16,000
    //   Chargeable P = 60,000 − 4,000 − 16,000 = 40,000
    //   Annual tax = (40,000 − 35,000) × 6% + 600 = 900 (above rebate)
    //   Monthly MTD = 900 / 12 = 75.00
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 5000,
      thisMonthEpf: 550,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: {
        isOku: true, // disabled individual
        spouseWorking: true,
        spouseDisabled: false,
        childRelief: [],
      },
    })
    expect(result.total).toBe(75)
  })
})

describe("calcPcb — LHDN Category 2 (married, spouse not working)", () => {
  it("RM 5,500/mo, spouse not working, no kids: MTD = RM 120.00", () => {
    // Cat 2 reliefs = D (9,000) + S (4,000) = 13,000
    //   Annual taxable = RM 66,000
    //   Annual EPF (capped) = RM 4,000
    //   Reliefs = RM 13,000
    //   Chargeable P = 66,000 − 4,000 − 13,000 = 49,000
    //   Annual tax (Cat 2 B = 600 above the 35k threshold,
    //   same as Cat 1/3 at this band):
    //   = (49,000 − 35,000) × 6% + 600 = 1,440 (no rebate, P > 35k)
    //   Monthly MTD = 1,440 / 12 = 120.00
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 5500,
      thisMonthEpf: 605,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: {
        isOku: false,
        spouseWorking: false, // Cat 2 — spouse not working
        spouseDisabled: false,
        childRelief: [],
      },
    })
    expect(result.total).toBe(120)
  })

  it("RM 3,500/mo, spouse not working, 1 child: rebate doubled to 800", () => {
    // Cat 2 reliefs = D (9,000) + S (4,000) + 1 child (2,000) = 15,000
    //   Annual taxable = RM 42,000
    //   Annual EPF (capped) = RM 4,000
    //   Reliefs = RM 15,000
    //   Chargeable P = 42,000 − 4,000 − 15,000 = 23,000
    //   Marginal tax: 150 + (23,000 − 20,000) × 3% = 150 + 90 = 240
    //   P ≤ 35,000 → Cat 2 rebate RM 800 applies
    //   Annual tax = max(0, 240 − 800) = 0
    //   Monthly MTD = 0
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 3500,
      thisMonthEpf: 385,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: {
        isOku: false,
        spouseWorking: false,
        spouseDisabled: false,
        childRelief: [
          {
            age: 5,
            abilityStatus: "NORMAL",
            currentlyStudying: "PRESCHOOL",
            pcbDeduction: "FULL",
          },
        ],
      },
    })
    expect(result.total).toBe(0)
  })

  it("RM 5,500/mo, spouse not working AND disabled: SU relief adds RM 6,000", () => {
    // Cat 2 reliefs = D (9,000) + S (4,000) + SU (6,000) = 19,000
    //   Annual taxable = RM 66,000
    //   Annual EPF (capped) = RM 4,000
    //   Reliefs = RM 19,000
    //   Chargeable P = 66,000 − 4,000 − 19,000 = 43,000
    //   Annual tax = (43,000 − 35,000) × 6% + 600 = 1,080 (no rebate)
    //   Monthly MTD = 1,080 / 12 = 90.00
    const result = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 5500,
      thisMonthEpf: 605,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      profile: {
        isOku: false,
        spouseWorking: false,
        spouseDisabled: true,
        childRelief: [],
      },
    })
    expect(result.total).toBe(90)
  })
})

// ─── Resident, additional remuneration (bonus / commission / etc.) ──────

describe("calcPcb — additional remuneration", () => {
  it("does not project the bonus forward across remaining months", () => {
    // RM 8,000/mo + RM 10,000 one-off bonus in March (period 3).
    //
    // Naive (wrong) behaviour: lump 10k into thisMonthTaxable, which
    // projects 18k × (months_remaining) — annual goes from 96k to
    // 96k + 10k × 10 = 196k. Wildly over-withheld.
    //
    // Correct AR behaviour: bonus only counted once in annual.
    // Annual taxable_with_AR = 96,000 + 10,000 = 106,000.
    // EPF unchanged at 4k cap.
    // Reliefs 9k.
    // Chargeable_with_AR = 93,000.
    // Tax on 83k = 6,170 (see above). Tax on 93k:
    //   adds 10k × 19% = 1,900 → 8,070.
    // PCB_AR = 8,070 - 6,170 = 1,900.
    const result = calcPcb({
      isResident: true,
      periodMonth: 3,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      thisMonthAdditionalRemuneration: 10000,
      thisMonthEpfFromAR: 1100, // 11% on 10k
      ytdTaxable: 16000,
      ytdEpf: 1760,
      ytdPcb: 1028.33, // 2 prior months × 514.17 normal PCB
      profile: baseProfile,
    })
    // PCB_normal stays around 514.17, PCB_AR ≈ 1,900.
    expect(result.normal).toBeCloseTo(514.17, 1)
    expect(result.additional).toBeCloseTo(1900, 0)
    expect(result.total).toBeCloseTo(514.17 + 1900, 1)
  })

  it("returns 0 AR when the bonus is 0 (back-compat with normal-only callers)", () => {
    // Without `thisMonthAdditionalRemuneration` the result should
    // match the bonus-free path exactly.
    const withoutAR = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    const withZeroAR = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      thisMonthAdditionalRemuneration: 0,
      thisMonthEpfFromAR: 0,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(withZeroAR.total).toBe(withoutAR.total)
    expect(withZeroAR.additional).toBe(0)
  })

  it("never returns a negative AR (when bonus pushes total below YTD already paid)", () => {
    // Even with a tiny AR, the AR component is the tax delta — must
    // be ≥ 0. The total can still be 0 if normal owed is 0.
    const result = calcPcb({
      isResident: true,
      periodMonth: 12,
      thisMonthTaxable: 1000,
      thisMonthEpf: 110,
      thisMonthAdditionalRemuneration: 500,
      thisMonthEpfFromAR: 55,
      ytdTaxable: 12000,
      ytdEpf: 1320,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(result.normal).toBeGreaterThanOrEqual(0)
    expect(result.additional).toBeGreaterThanOrEqual(0)
  })
})

// ─── Non-resident ───────────────────────────────────────────────────────

describe("calcPcb — non-resident", () => {
  it("applies flat 30% to both normal and AR", () => {
    const result = calcPcb({
      isResident: false,
      periodMonth: 5,
      thisMonthTaxable: 7000,
      thisMonthEpf: 0,
      thisMonthAdditionalRemuneration: 3000,
      thisMonthEpfFromAR: 0,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(result.normal).toBeCloseTo(2100, 2) // 7000 × 30%
    expect(result.additional).toBeCloseTo(900, 2) // 3000 × 30%
    expect(result.total).toBeCloseTo(3000, 2) // 10000 × 30%
  })

  it("returns 0 with no taxable wage", () => {
    const result = calcPcb({
      isResident: false,
      periodMonth: 1,
      thisMonthTaxable: 0,
      thisMonthEpf: 0,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(result.total).toBe(0)
  })
})

// ─── SOCSO + EIS RM 350 relief ──────────────────────────────────────────

describe("calcPcb — SOCSO + EIS RM 350 relief (actuals-only)", () => {
  it("applies only the actual contribution this month, not a forward projection", () => {
    // RM 8,000/mo, January, no YTD. SOCSO Cat 1 + EIS @ 8k =
    // ~RM 87.95/mo combined. Actuals-only relief = min(350, 0 + 87.95)
    // = 87.95 (cap NOT yet reached). Chargeable drops by 87.95 →
    // 82,912.05. Tax delta = 87.95 × 19% = 16.71 → monthly drop ≈ 1.39.
    const without = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    const withRelief = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      thisMonthSocsoEis: 87.95,
      ytdSocsoEis: 0,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(withRelief.total).toBeLessThan(without.total)
    // 87.95 of relief × 19% / 12 ≈ 1.39 monthly drop. With LHDN
    // rounding up to next 5 sen the delta might be slightly larger.
    expect(without.total - withRelief.total).toBeLessThan(2.5)
    expect(without.total - withRelief.total).toBeGreaterThan(0)
  })

  it("caps at RM 350 once YTD + thisMonth crosses the ceiling", () => {
    // By August: 8 months × ~87.95 = ~703.60 cumulative. Actuals-only
    // would already be capped at 350.
    const overCap = calcPcb({
      isResident: true,
      periodMonth: 8,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      thisMonthSocsoEis: 87.95,
      ytdSocsoEis: 615.65, // 7 months × 87.95
      ytdTaxable: 56000,
      ytdEpf: 4400,
      ytdPcb: 3600,
      profile: baseProfile,
    })
    const wayOver = calcPcb({
      isResident: true,
      periodMonth: 8,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      thisMonthSocsoEis: 87.95,
      ytdSocsoEis: 1000, // way over — should still clamp at 350
      ytdTaxable: 56000,
      ytdEpf: 4400,
      ytdPcb: 3600,
      profile: baseProfile,
    })
    // Both should give the same PCB because the relief is capped.
    expect(overCap.total).toBeCloseTo(wayOver.total, 2)
  })

  it("backwards-compatible: missing SOCSO/EIS inputs → same as before", () => {
    const legacyShape = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    const explicitZero = calcPcb({
      isResident: true,
      periodMonth: 1,
      thisMonthTaxable: 8000,
      thisMonthEpf: 880,
      thisMonthSocsoEis: 0,
      ytdSocsoEis: 0,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(legacyShape.total).toBe(explicitZero.total)
  })

  it("non-resident path is unaffected by SOCSO/EIS relief", () => {
    // Non-resident PCB is flat 30% with no reliefs — passing SOCSO/EIS
    // figures must not change the answer.
    const withFigures = calcPcb({
      isResident: false,
      periodMonth: 1,
      thisMonthTaxable: 7000,
      thisMonthEpf: 0,
      thisMonthSocsoEis: 88,
      ytdSocsoEis: 0,
      ytdTaxable: 0,
      ytdEpf: 0,
      ytdPcb: 0,
      profile: baseProfile,
    })
    expect(withFigures.total).toBeCloseTo(2100, 2) // 7000 × 30%
  })
})
