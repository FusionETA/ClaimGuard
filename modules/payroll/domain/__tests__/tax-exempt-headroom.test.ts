import { describe, expect, it } from "vitest"

import { consumeTaxExemptHeadroom } from "../tax-exempt-headroom"
import { PAYROLL_ADJUSTMENT_CATEGORY_META } from "../models"

const travel = PAYROLL_ADJUSTMENT_CATEGORY_META.allowance_travel_official

// Walks a year of imported months the way the importer does: in calendar
// order, carrying the used headroom forward.
function importMonths(amounts: number[], startUsed = 0) {
  let used = startUsed
  return amounts.map((amount) => {
    const r = consumeTaxExemptHeadroom({ meta: travel, amount, used })
    used += r.exempt
    return r.pcbTaxableAmount
  })
}

describe("consumeTaxExemptHeadroom", () => {
  it("guards the category this is about: travel is capped at RM 6,000", () => {
    expect(travel.taxExemptLimit).toBe(6000)
  })

  // The case that made v1 and v2 disagree: 5 × RM 500 official-duty travel,
  // imported Apr–Aug, all well inside the ceiling. Every month must say 0
  // taxable — null would mean "all of it", which put RM 2,500 into Y.
  it("marks travel under the ceiling as zero taxable, not null", () => {
    expect(importMonths([500, 500, 500, 500, 500])).toEqual([0, 0, 0, 0, 0])
  })

  it("carries the ceiling across months rather than resetting it", () => {
    // Two months clear, the third straddles, the fourth is fully taxable.
    expect(importMonths([2500, 2500, 2500, 2500])).toEqual([0, 0, 1500, null])
  })

  it("starts from headroom already used by earlier computed months", () => {
    expect(importMonths([2000, 2000], 5500)).toEqual([1500, null])
  })

  it("leaves a category with no ceiling fully taxable", () => {
    const r = consumeTaxExemptHeadroom({
      meta: PAYROLL_ADJUSTMENT_CATEGORY_META.allowance_standard,
      amount: 300,
      used: 0,
    })
    expect(r).toEqual({ pcbTaxableAmount: null, exempt: 0 })
  })

  it("ignores a row that is not PCB-subject at all", () => {
    const r = consumeTaxExemptHeadroom({
      meta: { kind: "ALLOWANCE", subjectToPcb: false, taxExemptLimit: 6000 },
      amount: 500,
      used: 0,
    })
    expect(r).toEqual({ pcbTaxableAmount: null, exempt: 0 })
  })

  it("ignores an unknown category", () => {
    expect(consumeTaxExemptHeadroom({ meta: undefined, amount: 500, used: 0 })).toEqual({
      pcbTaxableAmount: null,
      exempt: 0,
    })
  })
})
