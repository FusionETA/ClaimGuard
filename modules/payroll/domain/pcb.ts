/**
 * PCB (Potongan Cukai Bulanan) — Malaysian Monthly Tax Deduction.
 *
 * v1 scope:
 *   - Non-resident employees: flat 30% × monthly remuneration
 *   - Resident employees: NORMAL REMUNERATION path only — annualise →
 *     reliefs → progressive tax bands → minus YTD PCB → divide by
 *     remaining months
 *
 * **Caveats / preview status**
 *   1. Tax bands below are LHDN's 2024 individual-resident rates.
 *      LHDN's 2026 MTD spec confirms the formula is unchanged — only
 *      the TP1/TP3 deduction items moved. If the 2026 band thresholds
 *      shift, update `RESIDENT_TAX_BANDS_2024` here. Source:
 *      https://www.hasil.gov.my/en/employers/employer-payroll-data-specification/
 *   2. ONLY the normal-remuneration path is implemented. Additional
 *      remuneration (bonus, commission, arrears, director fee,
 *      gratuity) needs its own LHDN-specified formula in v1.2.
 *   3. TP1 deductions (life insurance, voluntary EPF, books, etc.) are
 *      not yet collected. Reliefs here cover personal, spouse, OKU,
 *      child only — a conservative subset.
 *   4. Returning Expert Program, Knowledge Worker, and the C-Suite
 *      non-citizen approved category use special rates — not
 *      implemented; treat as standard resident for now.
 *   5. Zakat offset against PCB is NOT YET implemented.
 *   6. `pcbBorneByEmployer` tax-gross-up is NOT YET implemented; the
 *      calc returns the same number regardless of who legally pays.
 *
 * Until covered by LHDN's testing test set this output should be
 * treated as a preview. Run LHDN's published test cases (see the spec
 * page above) against `calcPcb` before relying on it for live
 * submissions.
 */

import type { ChildRelief, PayrollProfileData } from "@/modules/payroll/domain/models"

// ─── Tax bands (LHDN 2024 individual-resident) ──────────────────────────

/**
 * Each band has an `upperBound` (RM annual chargeable income, inclusive)
 * and a marginal `rate`. The last band has upperBound Infinity (30%
 * for chargeable income above RM 2,000,000).
 */
const RESIDENT_TAX_BANDS_2024: ReadonlyArray<{
  upperBound: number
  rate: number
}> = [
  { upperBound: 5000, rate: 0 },
  { upperBound: 20000, rate: 0.01 },
  { upperBound: 35000, rate: 0.03 },
  { upperBound: 50000, rate: 0.06 },
  { upperBound: 70000, rate: 0.11 },
  { upperBound: 100000, rate: 0.19 },
  { upperBound: 400000, rate: 0.25 },
  { upperBound: 600000, rate: 0.26 },
  { upperBound: 2000000, rate: 0.28 },
  { upperBound: Number.POSITIVE_INFINITY, rate: 0.3 },
]

/**
 * Apply LHDN's progressive resident bands to an annual chargeable
 * income. Returns the annual tax owed in RM.
 *
 * Negative or zero income returns 0.
 */
export function applyResidentTaxBands(chargeableIncome: number): number {
  if (!Number.isFinite(chargeableIncome) || chargeableIncome <= 0) return 0
  let tax = 0
  let prevBound = 0
  for (const band of RESIDENT_TAX_BANDS_2024) {
    if (chargeableIncome <= band.upperBound) {
      tax += (chargeableIncome - prevBound) * band.rate
      return Math.max(0, tax)
    }
    tax += (band.upperBound - prevBound) * band.rate
    prevBound = band.upperBound
  }
  return Math.max(0, tax)
}

// ─── Reliefs ─────────────────────────────────────────────────────────────

/**
 * Per-child relief amounts. v1 uses conservative simplified values:
 *   - Non-studying child under 18: RM 2,000
 *   - Studying child (primary/secondary): RM 2,000
 *   - Higher-ed (diploma+ in Malaysia or degree+ overseas): RM 8,000
 *   - Disabled child: +RM 6,000 on top (so RM 8,000 / RM 14,000)
 *
 * Half-relief (when PCB share is HALF) halves the figures — happens
 * when both parents claim 50/50.
 */
function reliefForChild(child: ChildRelief): number {
  if (child.pcbDeduction === "NONE") return 0
  const baseStudying =
    child.currentlyStudying === "HIGHER_ED" ? 8000 : 2000
  const disabledBonus = child.abilityStatus === "DISABLED" ? 6000 : 0
  const total = baseStudying + disabledBonus
  return child.pcbDeduction === "HALF" ? Math.round((total / 2) * 100) / 100 : total
}

/**
 * Annual personal + family reliefs for a resident employee. EPF
 * relief is added on top by the orchestrator (it's capped at RM 4,000
 * combined with life insurance, but life-insurance TP1 isn't
 * collected in v1, so EPF gets the full RM 4,000 ceiling).
 */
export function calcResidentReliefs(profile: {
  isOku: boolean
  spouseWorking: boolean | null
  spouseDisabled: boolean | null
  childRelief: ChildRelief[]
}): number {
  let relief = 9000 // personal
  if (profile.isOku) relief += 6000

  // Spouse: only claimable when spouse not working (or no income).
  if (profile.spouseWorking === false) {
    relief += 4000
    if (profile.spouseDisabled === true) relief += 5000
  }

  for (const c of profile.childRelief) {
    relief += reliefForChild(c)
  }

  return relief
}

// ─── EPF relief cap ─────────────────────────────────────────────────────

const EPF_RELIEF_CAP = 4000

// ─── PCB orchestrator ───────────────────────────────────────────────────

export type CalcPcbInput = {
  /// Resident status drives the formula. Non-resident → 30% flat.
  isResident: boolean
  /// 1-12.
  periodMonth: number
  /// This month's taxable wage (proratedPay + totalAllowances + OT).
  /// Reimbursements + deductions are NOT taxable wage.
  thisMonthTaxable: number
  /// This month's EPF employee contribution. Used to estimate annual
  /// EPF deduction.
  thisMonthEpf: number
  /// YTD totals for THIS calendar year from previously submitted
  /// payslips for the same employee. When the employee joined
  /// mid-year, include their previous-employer figures from
  /// PayrollProfile.prevRemuneration + prevEpf (caller adds these in).
  ytdTaxable: number
  ytdEpf: number
  ytdPcb: number
  /// Relief data — pulled from PayrollProfile.
  profile: Pick<
    PayrollProfileData,
    | "isOku"
    | "spouseWorking"
    | "spouseDisabled"
    | "childRelief"
  >
}

/**
 * Compute this month's PCB.
 *
 * Returns 0 if any input is non-finite or the formula resolves to
 * negative tax owed (i.e. YTD overpaid).
 */
export function calcPcb(input: CalcPcbInput): number {
  // Non-resident: flat 30% of this month's taxable remuneration.
  // LHDN treats non-residents as a single-rate withholding without
  // reliefs.
  if (!input.isResident) {
    const flat = Math.max(0, input.thisMonthTaxable) * 0.3
    return round2(flat)
  }

  // Resident, normal-remuneration path.
  const monthsRemainingIncludingThis = Math.max(
    1,
    13 - clamp(input.periodMonth, 1, 12),
  )
  const futureMonths = monthsRemainingIncludingThis - 1

  // 1. Annualised taxable income estimate.
  //    annual = YTD + thisMonth + (thisMonth × future months)
  //    i.e. project this month's level forward to end of year.
  const annualTaxable =
    input.ytdTaxable +
    input.thisMonthTaxable +
    input.thisMonthTaxable * futureMonths

  // 2. Annualised EPF estimate, capped at RM 4,000.
  const annualEpf = Math.min(
    EPF_RELIEF_CAP,
    input.ytdEpf + input.thisMonthEpf + input.thisMonthEpf * futureMonths,
  )

  // 3. Reliefs.
  const reliefs = calcResidentReliefs(input.profile)

  // 4. Chargeable income.
  const chargeable = Math.max(0, annualTaxable - annualEpf - reliefs)

  // 5. Tax on annual chargeable.
  const annualTax = applyResidentTaxBands(chargeable)

  // 6. Subtract YTD PCB and spread over remaining months.
  const stillOwed = Math.max(0, annualTax - input.ytdPcb)
  const monthly = stillOwed / monthsRemainingIncludingThis

  return round2(monthly)
}

// ─── Tiny helpers ────────────────────────────────────────────────────────

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
