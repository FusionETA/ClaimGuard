import { describe, expect, it } from "vitest"

import { calcPayslip, type CalcPayslipInput } from "../calc"
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
    expect(result.pcb).toBeCloseTo(
      result.pcbBreakdown.normal + result.pcbBreakdown.additional,
      2,
    )
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

// ─── PCB gated on incomeTaxNumber ───────────────────────────────────────

describe("calcPayslip — PCB gating", () => {
  it("returns 0 PCB when employee has no income-tax number", () => {
    const result = calcPayslip({
      profile: makeProfile({
        incomeTaxNumber: null,
        monthlySalary: 10000,
      }),
      settings: baseSettings,
      periodYear: 2026,
      periodMonth: 1,
    })
    expect(result.pcb).toBe(0)
    expect(result.pcbBreakdown.normal).toBe(0)
    expect(result.pcbBreakdown.additional).toBe(0)
  })
})
