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

describe("applyResidentTaxBands (LHDN 2024)", () => {
  it("returns 0 for chargeable ≤ RM 5,000 (the 0% band)", () => {
    expect(applyResidentTaxBands(0)).toBe(0)
    expect(applyResidentTaxBands(5000)).toBe(0)
  })

  it("applies 1% on income between RM 5k and RM 20k", () => {
    // 20k chargeable: first 5k taxed at 0%, next 15k at 1% = RM 150.
    expect(applyResidentTaxBands(20000)).toBeCloseTo(150, 5)
  })

  it("applies the 6% step at RM 50k correctly", () => {
    // 0..5k: 0
    // 5k..20k: 15k × 1% = 150
    // 20k..35k: 15k × 3% = 450
    // 35k..50k: 15k × 6% = 900
    // Total at chargeable 50k = 1500.
    expect(applyResidentTaxBands(50000)).toBeCloseTo(1500, 5)
  })

  it("never returns negative tax", () => {
    expect(applyResidentTaxBands(-100)).toBe(0)
    expect(applyResidentTaxBands(Number.NaN)).toBe(0)
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
