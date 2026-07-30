import { describe, expect, it } from "vitest"

import { senDigits, toSen } from "../perkeso-format"

/**
 * PERKESO SOCSO/EIS/SKBBK money-field formatting.
 *
 * Regression guard for the July-2026 zwartify Design case: a zero
 * contribution was written as a bare "0", which PERKESO's ASSIST
 * parser rejected ("format not correct"). The field must always carry
 * its two cents digits — 0.00 → "000", never "0".
 */
describe("senDigits — PERKESO money field", () => {
  it("zero renders as 000, never a bare 0", () => {
    expect(senDigits(0)).toBe("000")
    expect(senDigits(null)).toBe("000")
    expect(senDigits(undefined)).toBe("000")
  })

  it("keeps the two cents digits for sub-ringgit amounts", () => {
    expect(senDigits(0.5)).toBe("050")
    expect(senDigits(0.05)).toBe("005")
  })

  it("matches the accepted zwartify Design contribution values", () => {
    expect(senDigits(29.75)).toBe("2975") // SOCSO employee
    expect(senDigits(104.15)).toBe("10415") // SOCSO employer
    expect(senDigits(44.65)).toBe("4465") // SKBBK
    expect(senDigits(8200)).toBe("820000") // salary
  })

  it("rounds half away from zero at the sen boundary", () => {
    expect(toSen(29.745)).toBe(2975)
    expect(senDigits(29.745)).toBe("2975")
  })
})
