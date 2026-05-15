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
