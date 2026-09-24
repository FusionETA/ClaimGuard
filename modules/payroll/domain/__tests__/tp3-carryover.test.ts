import { describe, expect, it } from "vitest"

import { foldTp3Carryover } from "../tp3-carryover"

const ownOrg = {
  ytdTaxable: 30_000,
  ytdEpf: 3_300,
  ytdPcb: 900,
  ytdZakat: 0,
  ytdAllowableDeductions: 1_200,
}

describe("foldTp3Carryover", () => {
  it("adds the declaration to every bucket it supplies", () => {
    const folded = foldTp3Carryover(
      ownOrg,
      {
        prevEmploymentYear: 2026,
        prevRemuneration: 54_000,
        prevEpf: 5_940,
        prevPcb: 2_100,
        prevZakat: 300,
        prevAllowableDeductions: 800,
      },
      2026,
    )

    expect(folded.ytdTaxable).toBe(84_000)
    expect(folded.ytdEpf).toBe(9_240)
    expect(folded.ytdPcb).toBe(3_000)
    expect(folded.ytdZakat).toBe(300)
    expect(folded.ytdAllowableDeductions).toBe(2_000)
  })

  // A TP3 declares ONE calendar year. Nothing ever clears the field, so
  // without this gate a 2026 declaration would inflate Y in 2027 and every
  // year after it — over-withholding forever.
  it("ignores a declaration tagged for a different year", () => {
    const folded = foldTp3Carryover(
      ownOrg,
      { prevEmploymentYear: 2026, prevRemuneration: 54_000 },
      2027,
    )

    expect(folded).toEqual(ownOrg)
  })

  it("ignores a declaration with no year, which belongs to no run", () => {
    const folded = foldTp3Carryover(
      ownOrg,
      { prevEmploymentYear: null, prevRemuneration: 54_000 },
      2026,
    )

    expect(folded).toEqual(ownOrg)
  })

  // The regression that made the preview and generation disagree: a rehire
  // keeps their ORIGINAL join date from a prior year, but their same-year
  // prev figures still carry. Join date is not part of the gate.
  it("carries for a rehire whose join date is in an earlier year", () => {
    const folded = foldTp3Carryover(
      ownOrg,
      { prevEmploymentYear: 2026, prevRemuneration: 12_000 },
      2026,
    )

    expect(folded.ytdTaxable).toBe(42_000)
  })

  describe("when the declaration already includes this org's own months", () => {
    it("subtracts this org's year-to-date rather than double-counting", () => {
      const folded = foldTp3Carryover(
        ownOrg,
        {
          prevEmploymentYear: 2026,
          prevIncludesPriorThisOrgPeriod: true,
          prevRemuneration: 50_000,
          prevEpf: 5_000,
          prevAllowableDeductions: 1_500,
        },
        2026,
      )

      // 50,000 declared total − 30,000 this org already paid = 20,000 new.
      expect(folded.ytdTaxable).toBe(50_000)
      expect(folded.ytdEpf).toBe(5_000)
      expect(folded.ytdAllowableDeductions).toBe(1_500)
    })

    // A declaration smaller than what this org has already paid is stale,
    // not evidence the employee earned negative income.
    it("clamps at zero when the declaration is behind this org's figures", () => {
      const folded = foldTp3Carryover(
        ownOrg,
        {
          prevEmploymentYear: 2026,
          prevIncludesPriorThisOrgPeriod: true,
          prevRemuneration: 10_000,
        },
        2026,
      )

      expect(folded.ytdTaxable).toBe(30_000)
    })
  })

  it("treats a missing or non-positive figure as nothing to carry", () => {
    const folded = foldTp3Carryover(
      ownOrg,
      { prevEmploymentYear: 2026, prevRemuneration: 0, prevEpf: null },
      2026,
    )

    expect(folded.ytdTaxable).toBe(30_000)
    expect(folded.ytdEpf).toBe(3_300)
  })

  // SOCSO + EIS has no prev* field: the RM 350 relief saturates within a few
  // months, so a mid-year joiner converges either way. Buckets the fold does
  // not own must survive it untouched.
  it("passes through buckets it does not carry", () => {
    const withExtras = {
      ...ownOrg,
      ytdSocsoEis: 210,
      ytdAllowanceByCategory: { allowance_travel_official: 2_500 },
    }

    const folded = foldTp3Carryover(
      withExtras,
      { prevEmploymentYear: 2026, prevRemuneration: 54_000 },
      2026,
    )

    expect(folded.ytdSocsoEis).toBe(210)
    expect(folded.ytdAllowanceByCategory).toEqual({
      allowance_travel_official: 2_500,
    })
  })
})
