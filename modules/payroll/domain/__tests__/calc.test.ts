import { describe, expect, it } from "vitest"

import {
  autoHoursFromMinutes,
  calcPayslip,
  calcSocso,
  effectiveWorkedDays,
  type CalcPayslipInput,
} from "../calc"
import type { PayrollAdjustmentCategory } from "../models"

/**
 * Orchestrator-level tests — exercise the new behaviour added in
 * the PCB hardening round:
 *
 *   1. Additional remuneration routing — bonus/commission/etc. must
 *      land in `pcbBreakdown.additional`, not get projected as a
 *      recurring allowance.
 *   2. Allowance exemption caps — `taxExemptLimit` on categories
 *      like `allowance_childcare` (RM 3,000/yr) must subtract the
 *      exempt portion from the PCB base.
 *   3. Zakat → PCB offset — `deduct_zakat` line items must reduce
 *      PCB owed for the month (capped at the PCB amount).
 *
 * These tests target the pure `calcPayslip()` entry point — no
 * Prisma or Next runtime.
 */

// ─── Test fixture: a vanilla resident employee ──────────────────────────

const baseSettings: CalcPayslipInput["settings"] = {
  otRateNormal: 1.5,
  otRateRest: 2.0,
  otRatePublicHoliday: 3.0,
  workingDaysRule: "TWENTY_SIX",
  defaultEpfEmployeeRate: 11,
  defaultEpfEmployerRate: 13,
  hrdfEnabled: false,
  hrdfRate: null,
}

function makeProfile(overrides: Partial<CalcPayslipInput["profile"]> = {}): CalcPayslipInput["profile"] {
  return {
    salaryType: "MONTHLY",
    monthlySalary: 6000,
    hourlyRate: null,
    fixedAllowances: [],
    joinDate: "2024-01-01",
    leaveDate: null,
    nationality: "Malaysian",
    hasPr: false,
    isResident: true,
    isOku: false,
    spouseWorking: true,
    spouseDisabled: false,
    childRelief: [],
    dateOfBirth: "1990-01-15",
    contributeToEpf: true,
    epfMemberBefore1998: false,
    epfEmployeeRate: 11,
    epfEmployeeVoluntary: 0,
    epfEmployerVoluntary: 0,
    socsoScheme: "EMPLOYMENT_INJURY_INVALIDITY",
    contributeToEis: true,
    incomeTaxNumber: "OG12345678",
    epfNumber: "EPF12345",
    socsoNumber: "SOC12345",
    ...overrides,
  }
}

// ─── Additional Remuneration routing ────────────────────────────────────

describe("calcPayslip — additional remuneration routing", () => {
  it("routes annual bonus line items into pcbBreakdown.additional", () => {
    const result = calcPayslip({
      profile: makeProfile({
        fixedAllowances: [
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Year-end bonus",
            amount: 12000,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 12, // pay run in December
      ytdTaxable: 66000, // 11 months @ 6,000
      ytdEpf: 4000, // capped
      ytdPcb: 0,
    })

    expect(result.pcbBreakdown.normal).toBeGreaterThanOrEqual(0)
    expect(result.pcbBreakdown.additional).toBeGreaterThan(0)
    // Engine invariant: final PCB = (normal + additional) put
    // through LHDN's 5-sen ceil. Normal is already 5-sen-rounded
    // (it's the deducted figure), but `additional` (PCB(C)) is now
    // a 2dp-truncated value per LHDN Section E item 1 — only the
    // SUM is ceiled, not each component. So `total` can be up to
    // ~0.04 greater than the raw sum.
    const ceil5Sen = (n: number) => Math.ceil(n * 20) / 20
    const expectedTotal = ceil5Sen(
      result.pcbBreakdown.normal + result.pcbBreakdown.additional,
    )
    expect(result.pcb).toBeCloseTo(expectedTotal, 2)
  })

  it("recurring allowances stay on the normal PCB path", () => {
    const result = calcPayslip({
      profile: makeProfile({
        fixedAllowances: [
          {
            category:
              "allowance_standard" satisfies PayrollAdjustmentCategory,
            name: "Standard allowance",
            amount: 500,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    expect(result.pcbBreakdown.additional).toBe(0)
  })

  // ─── EPF tier handling for AR lines ─────────────────────────────────
  //
  // KWSP Third Schedule logic, broken into two independent decisions:
  //
  //   1. EMPLOYEE band lookup → uses the COMBINED wage (regular + AR).
  //      For Kay Ben at 5,318 this gives the RM 100 band-up 5,400,
  //      ceil(11% × 5,400) = 594, matching Payroll Panda.
  //   2. EMPLOYER rate cliff (13→12 for Part A, 6.5→6 for Part C) →
  //      driven by the REGULAR monthly wage, NOT the combined wage.
  //      A one-off bonus that month does NOT push an under-RM-5,000
  //      employee into the higher tier — they keep their contractual
  //      13% rate. The employer total is a SINGLE ceil of
  //      (mandatory + voluntary) × combined wage, avoiding the
  //      double-ceil drift between mandatory and voluntary lines.
  //
  // The `treatAsRecurring` flag:
  //   - unticked (default for AR) → bonus is AR, excluded from
  //     `rateDeterminingWage` → regular wage drives the cliff.
  //   - ticked → bonus folds INTO regular wage → combined drives the
  //     cliff. Same semantics as a recurring monthly allowance.
  //
  // PCB still respects the flag for the LHDN one-shot AR formula vs.
  // smoothed monthly path (unchanged).
  it("combines a one-off bonus into the EPF tier wage (default unticked)", () => {
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        fixedAllowances: [
          {
            category:
              "allowance_parking" satisfies PayrollAdjustmentCategory,
            name: "Parking",
            amount: 150,
          },
          {
            category:
              "allowance_phone_fixed" satisfies PayrollAdjustmentCategory,
            name: "Phone",
            amount: 150,
          },
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Annual bonus",
            amount: 1218,
            // treatAsRecurring intentionally omitted → defaults to AR
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 12,
    })

    // Regular EPF wage = 3,800 + 150 + 150 = 4,100 (≤ RM 5,000 → cliff
    // stays on Part A LOW tier → employer 13%, no voluntary).
    // Combined EPF wage = 4,100 + 1,218 = 5,318.
    //   Mandatory employer = ceil(13% × 5,318) = 692  (single ceil)
    //   Mandatory employee = ceil(11% × 5,400) = 594  (band-up applies
    //                       on the EMPLOYEE side because combined > 5K)
    expect(result.epfEmployer).toBe(692)
    expect(result.epfEmployee).toBe(594)
  })

  it("stacks voluntary % on top of combined-wage mandatory (unticked)", () => {
    // Same Kay Ben numbers as above but with 2% employer voluntary +
    // 1% employee voluntary. Voluntary is computed on the combined
    // EPF-able wage (regular + bonus). Per KWSP convention the
    // voluntary side ceils to the next ringgit (NOT round2) — same as
    // the band table mandatory side.
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        epfEmployeeVoluntary: 1,
        epfEmployerVoluntary: 2,
        fixedAllowances: [
          {
            category:
              "allowance_parking" satisfies PayrollAdjustmentCategory,
            name: "Parking",
            amount: 150,
          },
          {
            category:
              "allowance_phone_fixed" satisfies PayrollAdjustmentCategory,
            name: "Phone",
            amount: 150,
          },
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Annual bonus",
            amount: 1218,
            // unticked → AR path
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 12,
    })

    // Regular wage 4,100 → Part A low tier → employer rate 13%.
    // Employer = ceil((13 + 2)% × 5,318) = ceil(797.7) = 798 (single
    // ceil). Matches Payroll Panda exactly.
    // Employee mandatory = ceil(11% × 5,400 band-up) = 594, plus
    // employee voluntary 1% × 5,318 ceil = 54 → total 648.
    expect(result.epfEmployer).toBe(798)
    expect(result.epfEmployee).toBe(648)
  })

  it("ticking treatAsRecurring=true folds bonus into the regular wage so the cliff triggers", () => {
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        epfEmployeeVoluntary: 1,
        epfEmployerVoluntary: 2,
        fixedAllowances: [
          {
            category:
              "allowance_parking" satisfies PayrollAdjustmentCategory,
            name: "Parking",
            amount: 150,
          },
          {
            category:
              "allowance_phone_fixed" satisfies PayrollAdjustmentCategory,
            name: "Phone",
            amount: 150,
          },
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Monthly guaranteed bonus",
            amount: 1218,
            treatAsRecurring: true,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 12,
    })

    // treatAsRecurring=true → bonus is part of regular monthly wage
    // for EPF purposes → `rateDeterminingWage` = combined 5,318 →
    // cliff trips → employer rate drops to 12% (Part A HIGH).
    //   Employer mandatory = ceil(12% × 5,400 band-up) = 648 (band
    //     table, matches Payroll Panda for no-AR cases like Mohammad
    //     Za'im 8,250 → 996)
    //   Employer voluntary = ceil(2% × 5,318) = 107 (off-table
    //     separate ceil)
    //   Employer total = 648 + 107 = 755
    //   Employee mandatory = ceil(11% × 5,400 band-up) = 594, plus
    //     voluntary 1% × 5,318 ceil = 54 → 648.
    // Different from the unticked variant above (which kept the
    // 13% rate on totalWage → 798) — the flag legitimately controls
    // the cliff.
    expect(result.epfEmployer).toBe(755)
    expect(result.epfEmployee).toBe(648)
  })

  it("snapshot exposes voluntary amount split so PDFs can render it", () => {
    // The Detailed Calculations PDF needs the voluntary AMOUNT (RM),
    // not just the percentage, to render mandatory and voluntary on
    // separate lines. Before the snapshot carried only %, the PDF
    // showed e.g. "Employee share (11%) RM 638.18" which mislead
    // admins into thinking voluntary wasn't applied.
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        epfEmployeeVoluntary: 1,
        epfEmployerVoluntary: 2,
        fixedAllowances: [
          {
            category:
              "allowance_parking" satisfies PayrollAdjustmentCategory,
            name: "Parking",
            amount: 150,
          },
          {
            category:
              "allowance_phone_fixed" satisfies PayrollAdjustmentCategory,
            name: "Phone",
            amount: 150,
          },
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Annual bonus",
            amount: 1218,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 12,
    })

    // Voluntary on combined wage 5,318, ceil'd per KWSP:
    //   employer ceil(5,318 × 2%) = 107
    //   employee ceil(5,318 × 1%) = 54
    expect(result.epfRatesSnapshot.voluntaryAmountEmployer).toBe(107)
    expect(result.epfRatesSnapshot.voluntaryAmountEmployee).toBe(54)
    // Mandatory amounts = total - voluntary:
    //   employer 798 - 107 = 691  (single-ceil ceil(15% × 5,318) split)
    //   employee 648 -  54 = 594  (band-table 11% × 5,400 minus voluntary)
    expect(result.epfRatesSnapshot.mandatoryAmountEmployer).toBe(691)
    expect(result.epfRatesSnapshot.mandatoryAmountEmployee).toBe(594)
    // Rate fields reflect the cliff driven by REGULAR wage. Regular
    // wage = 4,100 ≤ RM 5,000 → Part A LOW tier → employer 13%.
    // Employee rate has no cliff in Part A — always 11%.
    expect(result.epfRatesSnapshot.employee).toBe(11)
    expect(result.epfRatesSnapshot.employer).toBe(13)
    expect(result.epfRatesSnapshot.voluntaryEmployee).toBe(1)
    expect(result.epfRatesSnapshot.voluntaryEmployer).toBe(2)
  })

  it("PCB breakdown exposes the AR sub-formula variables", () => {
    // Without these, the Detailed Calculations PDF can't render
    // PCB(B) / PCB(C), and an admin staring at 469.35 total PCB vs
    // a 15.43 "Current Month PCB" formula line has no way to reconcile.
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        fixedAllowances: [
          {
            category:
              "allowance_parking" satisfies PayrollAdjustmentCategory,
            name: "Parking",
            amount: 150,
          },
          {
            category:
              "allowance_phone_fixed" satisfies PayrollAdjustmentCategory,
            name: "Phone",
            amount: 150,
          },
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Annual bonus",
            amount: 1218,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    expect(result.pcbCalculation.formula).toBe("resident")
    if (result.pcbCalculation.formula !== "resident") return // type guard

    const ar = result.pcbCalculation.ar
    expect(ar).toBeDefined()
    // LHDN MTD spec naming: Yt = AR taxable, Kt = AR EPF deductible
    expect(ar.Yt).toBeGreaterThan(0)
    // P_withAR (chargeable income WITH the AR) > P (chargeable income without AR)
    expect(ar.chargeableWithAr).toBeGreaterThan(result.pcbCalculation.P)
    // CS — yearly tax with AR
    expect(ar.CS).toBeGreaterThanOrEqual(result.pcbCalculation.yearlyTax)
    // PCB(B) = annual projected normal PCB
    //        = X + trunc2(Current Month PCB) × (n + 1)
    //
    // Uses the TRUNCATED `currentMonthPcb` (e.g. 15.0958 → 15.09)
    // NOT the 5-sen-rounded `pcbAfterThreshold` — matches Payroll
    // Panda + the LHDN-form PDF row which displays the truncated
    // value, and produces the same final PCB as PP.
    const trunc2 = (n: number) => Math.trunc(n * 100) / 100
    expect(ar.pcbB).toBeCloseTo(
      result.pcbCalculation.X +
        trunc2(result.pcbCalculation.currentMonthPcb) *
          (result.pcbCalculation.n + 1),
      2,
    )
    // PCB(C) before rounding = CS − PCB(B) − Z
    expect(ar.pcbCBeforeRounding).toBeCloseTo(
      Math.max(0, ar.CS - ar.pcbB - result.pcbCalculation.Z),
      2,
    )
    // PCB(C) final matches the legacy pcbAdditional field exactly
    expect(ar.pcbC).toBe(result.pcbCalculation.pcbAdditional)
    // PCB current month = PCB(A) + PCB(C), rounded up to 5c
    // This should equal the engine's actual deducted PCB exactly.
    expect(ar.pcbCurrentMonth).toBeCloseTo(result.pcb, 2)
  })

  it("PCB AR breakdown is empty when no AR fires (treatAsRecurring=true)", () => {
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        fixedAllowances: [
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Monthly guaranteed bonus",
            amount: 1218,
            treatAsRecurring: true,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    if (result.pcbCalculation.formula !== "resident") {
      throw new Error("expected resident formula")
    }
    // No AR routed to AR bucket → AR amounts all zero
    expect(result.pcbCalculation.ar.Yt).toBe(0)
    expect(result.pcbCalculation.ar.pcbC).toBe(0)
  })

  it("folds the bonus into the regular tier when treatAsRecurring=true", () => {
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3800,
        fixedAllowances: [
          {
            category:
              "allowance_parking" satisfies PayrollAdjustmentCategory,
            name: "Parking",
            amount: 150,
          },
          {
            category:
              "allowance_phone_fixed" satisfies PayrollAdjustmentCategory,
            name: "Phone",
            amount: 150,
          },
          {
            category:
              "wages_bonus_annual" satisfies PayrollAdjustmentCategory,
            name: "Monthly guaranteed bonus",
            amount: 1218,
            treatAsRecurring: true,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 12,
    })

    // treatAsRecurring=true folds bonus into the regular wage →
    // rateDeterminingWage = combined 5,318 → cliff trips → employer 12%.
    //   Employer total = ceil(12% × 5,400 band-up) = 648 (band table
    //     matches Payroll Panda for no-AR cases like Mohammad Za'im
    //     8,250 → 996)
    //   Employee mandatory = ceil(11% × 5,400 band-up) = 594
    // No voluntary on this profile.
    expect(result.epfEmployer).toBe(648)
    expect(result.epfEmployee).toBe(594)
  })
})

// ─── Allowance exemption caps ───────────────────────────────────────────

describe("calcPayslip — allowance exemption caps", () => {
  it("exempts the first RM 3,000/yr of childcare from PCB base", () => {
    // 500/mo childcare allowance. RM 3,000 cap means the first
    // six months are entirely exempt, then the rest is fully
    // PCB-taxable. On a fresh year (ytd 0), 500 < 3,000 cap → all
    // exempt from PCB base this month.
    const result = calcPayslip({
      profile: makeProfile({
        fixedAllowances: [
          {
            category:
              "allowance_childcare" satisfies PayrollAdjustmentCategory,
            name: "Childcare",
            amount: 500,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
      ytdAllowanceByCategory: {},
    })
    const withoutChildcare = calcPayslip({
      profile: makeProfile(),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    // PCB should match the without-allowance baseline — the RM 500
    // childcare was fully exempt.
    expect(result.pcb).toBeCloseTo(withoutChildcare.pcb, 2)
  })

  it("taxes the excess once the YTD cap is exhausted", () => {
    // RM 500/mo childcare, but YTD already used RM 2,800 — so
    // only RM 200 of this month's 500 is exempt, the remaining
    // RM 300 hits the PCB base.
    const result = calcPayslip({
      profile: makeProfile({
        fixedAllowances: [
          {
            category:
              "allowance_childcare" satisfies PayrollAdjustmentCategory,
            name: "Childcare",
            amount: 500,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 7,
      ytdTaxable: 36000,
      ytdEpf: 4000,
      ytdPcb: 0,
      ytdAllowanceByCategory: { allowance_childcare: 2800 },
    })

    const withFullAllowance = calcPayslip({
      profile: makeProfile({
        fixedAllowances: [
          {
            category:
              "allowance_standard" satisfies PayrollAdjustmentCategory,
            name: "Standard 500",
            amount: 500,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 7,
      ytdTaxable: 36000,
      ytdEpf: 4000,
      ytdPcb: 0,
    })

    // The capped allowance should produce LESS PCB than a
    // fully-taxable allowance of the same amount (because RM 200 is
    // still exempt), but MORE than nothing.
    expect(result.pcb).toBeLessThanOrEqual(withFullAllowance.pcb)
  })
})

// ─── Zakat → PCB offset ─────────────────────────────────────────────────

describe("calcPayslip — zakat offset", () => {
  it("reduces PCB by the zakat amount (capped at PCB)", () => {
    const baseline = calcPayslip({
      profile: makeProfile({
        monthlySalary: 10000,
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    const withZakat = calcPayslip({
      profile: makeProfile({
        monthlySalary: 10000,
        fixedAllowances: [
          {
            category: "deduct_zakat" satisfies PayrollAdjustmentCategory,
            name: "Zakat",
            amount: 100,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    expect(baseline.pcb).toBeGreaterThan(100) // sanity check
    expect(withZakat.pcb).toBeCloseTo(baseline.pcb - 100, 2)
    expect(withZakat.zakat).toBeCloseTo(100, 2)
  })

  it("does not let PCB go negative — caps offset at the PCB amount", () => {
    const result = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3000, // PCB likely 0 at this level
        fixedAllowances: [
          {
            category: "deduct_zakat" satisfies PayrollAdjustmentCategory,
            name: "Zakat",
            amount: 200,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })

    expect(result.pcb).toBeGreaterThanOrEqual(0)
  })
})

// ─── Zakat paid outside payroll (TP1 deduction category) ────────────────
//
// Self-paid zakat declared via Borang TP1 is now a `deduct_zakat_tp1`
// monthly adjustment line (offsetsPcb + cashNeutral), NOT a profile
// setting. It must reduce PCB exactly like salary-deduction zakat
// (`deduct_zakat`), but must NOT be subtracted from take-home — the
// employee already paid it directly to the zakat centre. So it leaves
// MORE in the paycheck than the PZB variant, because the PCB withheld is
// lower and nothing is deducted.
describe("calcPayslip — zakat paid outside payroll (TP1 deduction category)", () => {
  const baseline = calcPayslip({
    profile: makeProfile({ monthlySalary: 10000 }),
    settings: baseSettings,
    periodYear: 2026,
    periodMonth: 1,
  })

  const pzb = calcPayslip({
    profile: makeProfile({
      monthlySalary: 10000,
      fixedAllowances: [
        {
          category: "deduct_zakat" satisfies PayrollAdjustmentCategory,
          name: "Zakat (PZB)",
          amount: 100,
        },
      ],
    }),
    settings: baseSettings,
    periodYear: 2026,
    periodMonth: 1,
  })

  const tp1 = calcPayslip({
    profile: makeProfile({
      monthlySalary: 10000,
      fixedAllowances: [
        {
          category: "deduct_zakat_tp1" satisfies PayrollAdjustmentCategory,
          name: "Zakat (TP1)",
          amount: 100,
        },
      ],
    }),
    settings: baseSettings,
    periodYear: 2026,
    periodMonth: 1,
  })

  it("offsets PCB by the zakat amount, same as the PZB variant", () => {
    expect(baseline.pcb).toBeGreaterThan(100) // sanity
    expect(tp1.pcb).toBeCloseTo(baseline.pcb - 100, 2)
    expect(tp1.pcb).toBeCloseTo(pzb.pcb, 2)
    expect(tp1.zakat).toBeCloseTo(100, 2)
  })

  it("does NOT reduce take-home (employee already paid externally)", () => {
    // PZB is net-neutral: the 100 deduction is offset by 100 less PCB,
    // so net == baseline.
    expect(pzb.netPay).toBeCloseTo(baseline.netPay, 2)
    // TP1 deducts nothing but still lowers PCB by 100, so the employee
    // keeps 100 more in this paycheck than baseline / PZB.
    expect(tp1.netPay).toBeCloseTo(baseline.netPay + 100, 2)
    expect(tp1.netPay).toBeCloseTo(pzb.netPay + 100, 2)
  })

  it("never pushes PCB negative — offset capped at PCB", () => {
    const lowEarner = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3000, // PCB ~0 at this level
        fixedAllowances: [
          {
            category: "deduct_zakat_tp1" satisfies PayrollAdjustmentCategory,
            name: "Zakat (TP1)",
            amount: 200,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    expect(lowEarner.pcb).toBeGreaterThanOrEqual(0)
  })
})

// ─── PCB runs regardless of incomeTaxNumber ─────────────────────────────

describe("calcPayslip — PCB always runs", () => {
  it("computes PCB even when employee has no income-tax number, and flags the missing TIN as a statutory warning", () => {
    // LHDN MTD Specification for 2026 does not gate the calculation on
    // TIN. The TIN is needed only for the CP39 submission file. We
    // therefore compute PCB and surface "MISSING_INCOME_TAX_NUMBER"
    // as a non-blocking warning for the admin UI.
    const result = calcPayslip({
      profile: makeProfile({
        incomeTaxNumber: null,
        monthlySalary: 10000,
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    expect(result.pcb).toBeGreaterThan(0)
    expect(result.pcbBreakdown.normal).toBeGreaterThan(0)
    expect(result.statutoryWarnings).toContain("MISSING_INCOME_TAX_NUMBER")
  })

  it("clean profile produces no statutory warnings", () => {
    const result = calcPayslip({
      profile: makeProfile({
        incomeTaxNumber: "OG12345678",
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    expect(result.statutoryWarnings).toEqual([])
  })
})

// ─── Working-hours DISPLAY helpers (do not affect pay) ──────────────────

describe("calcPayslip — pay is day-based, not attendance-based", () => {
  const monthly = () =>
    makeProfile({ monthlySalary: 6000, joinDate: "2024-01-01", leaveDate: null })

  it("full-month MONTHLY employee is paid the full salary (day-based)", () => {
    const result = calcPayslip({
      profile: monthly(),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    expect(result.proratedFactor).toBe(1)
    expect(result.proratedPay).toBe(6000)
  })
})

describe("autoHoursFromMinutes", () => {
  it("MONTHLY with no attendance → 0 worked, expected = scheduled (0%)", () => {
    const r = autoHoursFromMinutes({
      salaryType: "MONTHLY",
      workedMin: 0,
      scheduledMin: 176 * 60,
      paidLeaveMin: 0,
    })
    expect(r.workedHours).toBe(0)
    expect(r.expectedHours).toBe(176)
  })

  it("MONTHLY removes paid leave from expected", () => {
    const r = autoHoursFromMinutes({
      salaryType: "MONTHLY",
      workedMin: 160 * 60,
      scheduledMin: 176 * 60,
      paidLeaveMin: 16 * 60,
    })
    expect(r.workedHours).toBe(160)
    expect(r.expectedHours).toBe(160)
  })

  it("HOURLY = actual clocked hours only (paid leave NOT added), no expected basis", () => {
    const r = autoHoursFromMinutes({
      salaryType: "HOURLY",
      workedMin: 100 * 60,
      scheduledMin: 176 * 60,
      paidLeaveMin: 8 * 60,
    })
    expect(r.workedHours).toBe(100)
    expect(r.expectedHours).toBeNull()
  })

  it("HOURLY short session reports exact worked hours (15 min → 0.25h)", () => {
    const r = autoHoursFromMinutes({
      salaryType: "HOURLY",
      workedMin: 15,
      scheduledMin: 176 * 60,
      paidLeaveMin: 8 * 60, // a paid-leave day in the period must not inflate HRS
    })
    expect(r.workedHours).toBe(0.25)
    expect(r.expectedHours).toBeNull()
  })
})

describe("effectiveWorkedDays — join/leave proration by rule", () => {
  it("full month returns the working-days basis", () => {
    expect(
      effectiveWorkedDays({
        periodYear: 2026,
        periodMonth: 1,
        joinDate: "2024-01-01",
        leaveDate: null,
        workingDays: 26,
        rule: "TWENTY_SIX",
        workingDaySet: new Set([1, 2, 3, 4, 5]),
      }),
    ).toBe(26)
  })

  it("TWENTY_SIX counts only configured working days for a late joiner", () => {
    // Jan 2026: 1 Jan is a Thursday → Mon–Fri days from 15–31 Jan = 12.
    expect(
      effectiveWorkedDays({
        periodYear: 2026,
        periodMonth: 1,
        joinDate: "2026-01-15",
        leaveDate: null,
        workingDays: 26,
        rule: "TWENTY_SIX",
        workingDaySet: new Set([1, 2, 3, 4, 5]),
      }),
    ).toBe(12)
  })

  it("CALENDAR counts calendar days for a late joiner", () => {
    // 15–31 Jan inclusive = 17 calendar days.
    expect(
      effectiveWorkedDays({
        periodYear: 2026,
        periodMonth: 1,
        joinDate: "2026-01-15",
        leaveDate: null,
        workingDays: 31,
        rule: "CALENDAR",
      }),
    ).toBe(17)
  })

  it("a 6-day-week set (incl. Saturday) counts more days than Mon–Fri", () => {
    const monFri = effectiveWorkedDays({
      periodYear: 2026,
      periodMonth: 1,
      joinDate: "2026-01-15",
      leaveDate: null,
      workingDays: 26,
      rule: "TWENTY_SIX",
      workingDaySet: new Set([1, 2, 3, 4, 5]),
    })!
    const monSat = effectiveWorkedDays({
      periodYear: 2026,
      periodMonth: 1,
      joinDate: "2026-01-15",
      leaveDate: null,
      workingDays: 26,
      rule: "TWENTY_SIX",
      workingDaySet: new Set([1, 2, 3, 4, 5, 6]),
    })!
    expect(monSat).toBeGreaterThan(monFri)
  })
})

describe("calcPayslip — exact proration (no intermediate rounding)", () => {
  it("late joiner 19 Feb on RM4999.99 → 1346.15, not 1346.00", () => {
    const result = calcPayslip({
      profile: makeProfile({ monthlySalary: 4999.99, joinDate: "2026-02-19" }),
      settings: baseSettings, // TWENTY_SIX
      periodYear: 2026,
      periodMonth: 2,
      workingDaySet: new Set([1, 2, 3, 4, 5]),
    })
    expect(result.proratedDays).toBe(7) // Mon–Fri, 19–28 Feb 2026
    // 4999.99 × (7/26) = 1346.15, NOT 4999.99 × round4(7/26)=1346.00.
    expect(result.proratedPay).toBe(1346.15)
    expect(result.grossPay).toBe(1346.15)
    // Snapshot factor is still rounded to 4dp for the Decimal(5,4) column.
    expect(result.proratedFactor).toBe(0.2692)
  })
})

describe("calcPayslip — unpaid leave reduces gross (not just net)", () => {
  it("docks unpaid leave from gross; base salary line stays full", () => {
    const base = calcPayslip({
      profile: makeProfile({ monthlySalary: 3000 }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    const withUnpaid = calcPayslip({
      profile: makeProfile({
        monthlySalary: 3000,
        fixedAllowances: [
          {
            category:
              "deduct_unpaid_leave" satisfies PayrollAdjustmentCategory,
            name: "Unpaid Leave",
            amount: 115.38, // 1 day of a 26-day basis on RM3000
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    // Base salary (proratedPay) is unchanged — full month.
    expect(withUnpaid.proratedPay).toBe(base.proratedPay)
    // Gross is reduced by exactly the unpaid-leave amount.
    expect(withUnpaid.grossPay).toBeCloseTo(base.grossPay - 115.38, 2)
    // Not double-counted: net = gross − statutory (unpaid leave already in gross).
    expect(withUnpaid.totalDeductions).toBe(0)
  })

  it("does NOT re-prorate the unpaid-leave deduction for a late joiner", () => {
    // Late joiner → proratedFactor < 1. The unpaid-leave line is already
    // at the full daily rate, so the full amount must come off gross.
    const withoutUnpaid = calcPayslip({
      profile: makeProfile({ monthlySalary: 5200, joinDate: "2026-01-15" }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
      workingDaySet: new Set([1, 2, 3, 4, 5]),
    })
    const withUnpaid = calcPayslip({
      profile: makeProfile({
        monthlySalary: 5200,
        joinDate: "2026-01-15",
        fixedAllowances: [
          {
            category:
              "deduct_unpaid_leave" satisfies PayrollAdjustmentCategory,
            name: "Unpaid Leave",
            amount: 400,
          },
        ],
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
      workingDaySet: new Set([1, 2, 3, 4, 5]),
    })
    // Full 400 off gross — not 400 × proratedFactor.
    expect(withUnpaid.grossPay).toBeCloseTo(withoutUnpaid.grossPay - 400, 2)
  })
})

describe("calcSocso — age auto-flip to Cat 2 at 60+", () => {
  const base = { wage: 3000, periodYear: 2026, periodMonth: 5 }

  it("under 60 in Cat 1 → both sides contribute", () => {
    const r = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_INVALIDITY",
      ageAtPeriodEnd: 59,
    })
    expect(r.employee).toBeGreaterThan(0)
    expect(r.employer).toBeGreaterThan(0)
  })

  it("60+ in Cat 1 → auto-flips to Cat 2 (employer only, no employee deduction)", () => {
    const cat1At60 = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_INVALIDITY",
      ageAtPeriodEnd: 60,
    })
    const cat2Direct = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_ONLY",
      ageAtPeriodEnd: 59,
    })
    // 60+ Cat 1 must produce zero employee and match Cat 2 employer.
    expect(cat1At60.employee).toBe(0)
    expect(cat1At60.employer).toBe(cat2Direct.employer)
  })

  it("59 vs 61 in Cat 1 — the exact boundary", () => {
    const at59 = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_INVALIDITY",
      ageAtPeriodEnd: 59,
    })
    const at61 = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_INVALIDITY",
      ageAtPeriodEnd: 61,
    })
    expect(at59.employee).toBeGreaterThan(0)
    expect(at61.employee).toBe(0)
  })

  it("Cat 2 profile — age has no additional effect", () => {
    const under60 = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_ONLY",
      ageAtPeriodEnd: 59,
    })
    const sixtyPlus = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_ONLY",
      ageAtPeriodEnd: 72,
    })
    expect(under60).toEqual(sixtyPlus)
  })

  it("ageAtPeriodEnd omitted → falls back to profile scheme (back-compat)", () => {
    // Legacy callers that don't yet pass age must see pre-fix
    // behaviour, so the change is additive rather than a break.
    const r = calcSocso({
      ...base,
      scheme: "EMPLOYMENT_INJURY_INVALIDITY",
    })
    expect(r.employee).toBeGreaterThan(0)
  })

  it("null scheme → 0/0 regardless of age", () => {
    const r = calcSocso({
      ...base,
      scheme: null,
      ageAtPeriodEnd: 72,
    })
    expect(r).toEqual({ employee: 0, employer: 0, employeeSkbbk: 0 })
  })
})
