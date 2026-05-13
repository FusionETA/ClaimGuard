/**
 * PCB (Potongan Cukai Bulanan) — Malaysian Monthly Tax Deduction.
 *
 * v1 scope:
 *   - Non-resident employees: flat 30% × monthly remuneration (both
 *     normal AND any additional remuneration in the same month).
 *   - Resident employees, NORMAL remuneration: annualise →
 *     reliefs → progressive tax bands → minus YTD PCB → divide by
 *     remaining months.
 *   - Resident employees, ADDITIONAL remuneration (bonus, commission,
 *     arrears, director fee, gratuity, etc.): compute as the *tax
 *     delta* of layering the AR on top of the annual chargeable
 *     income at this month's projection — i.e. NOT projected forward
 *     across the remaining months. See `calcPcb` for the formula.
 *
 * **Caveats / preview status**
 *   1. Tax bands below are LHDN's 2024 individual-resident rates.
 *      LHDN's 2026 MTD spec confirms the formula is unchanged — only
 *      the TP1/TP3 deduction items moved. If the 2026 band thresholds
 *      shift, update `RESIDENT_TAX_BANDS_2024` here. Source:
 *      https://www.hasil.gov.my/en/employers/employer-payroll-data-specification/
 *   2. TP1 deductions (life insurance, voluntary EPF, books, etc.) are
 *      not yet collected. Reliefs here cover personal, spouse, OKU,
 *      child only — a conservative subset.
 *   3. Returning Expert Program, Knowledge Worker, and the C-Suite
 *      non-citizen approved category use special rates — not
 *      implemented; treat as standard resident for now.
 *   4. `pcbBorneByEmployer` tax-gross-up is NOT YET implemented; the
 *      calc returns the same number regardless of who legally pays.
 *
 * Zakat offset is applied by the orchestrator (`calcPayslip`) after
 * the PCB amount comes out of this function — see calc.ts.
 *
 * Run LHDN's published test cases against `calcPcb` before relying on
 * it for live submissions. A starter suite lives in
 * `modules/payroll/domain/__tests__/pcb.test.ts`.
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
  /// This month's NORMAL taxable wage (proratedPay + recurring
  /// allowances + OT). Reimbursements + deductions are NOT taxable
  /// wage. Additional-remuneration items (bonus, commission, etc.)
  /// must NOT be lumped in here — pass them separately as
  /// `thisMonthAdditionalRemuneration`.
  thisMonthTaxable: number
  /// This month's EPF employee contribution from NORMAL pay. Used to
  /// estimate annual EPF deduction.
  thisMonthEpf: number
  /// This month's additional remuneration (one-off bonus, commission,
  /// arrears, director fee, gratuity, etc., already filtered through
  /// `subjectToPcb` and any cap deductions). Defaults to 0 so legacy
  /// callers without AR keep working unchanged.
  thisMonthAdditionalRemuneration?: number
  /// EPF contribution on the additional remuneration alone (for
  /// AR rows where `subjectToEpf` is true, e.g. bonuses). Counted on
  /// top of `thisMonthEpf` when sizing the annual EPF deduction in
  /// the with-AR branch. Defaults to 0.
  thisMonthEpfFromAR?: number
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
 * Result splits cleanly into:
 *   - `normal` — PCB on the recurring monthly pay, computed by
 *     annualising and dividing across the months remaining.
 *   - `additional` — PCB attributable to one-off remuneration this
 *     month (bonus, commission, arrears, director fee, etc.).
 *     Computed as the *tax delta* of adding the AR to the annual
 *     chargeable income, with no forward projection — so a RM10,000
 *     bonus doesn't get treated like a RM10,000/mo recurring
 *     allowance.
 *
 * `total` is the sum of both, rounded once at the end. Returns 0
 * components when inputs are non-finite or YTD has overpaid.
 *
 * **LHDN formula reference**
 *   Let
 *     N           = months remaining including this one (= 13 - month)
 *     F           = N - 1
 *     ytd_t       = `ytdTaxable`
 *     m           = `thisMonthTaxable`
 *     ar          = `thisMonthAdditionalRemuneration`
 *     annual_t    = ytd_t + m + m*F
 *     epf         = min(RM4,000, ytd_epf + m_epf + m_epf*F)
 *     r           = residentReliefs
 *     P           = max(0, annual_t - epf - r)
 *     P_ar        = max(0, annual_t + ar - epf_with_ar - r)
 *     T(x)        = resident progressive tax on x
 *     PCB_normal  = max(0, T(P) - ytd_pcb) / N
 *     PCB_ar      = max(0, T(P_ar) - T(P))
 *     PCB_total   = PCB_normal + PCB_ar
 */
export type CalcPcbResult = {
  normal: number
  additional: number
  total: number
}

export function calcPcb(input: CalcPcbInput): CalcPcbResult {
  const normalTaxable = Math.max(0, input.thisMonthTaxable)
  const arTaxable = Math.max(0, input.thisMonthAdditionalRemuneration ?? 0)

  // Non-resident: flat 30% across the entire taxable amount. LHDN
  // treats non-residents as a single-rate withholding without
  // reliefs, so AR vs normal makes no difference — but we still
  // split the result so the caller can report it correctly.
  if (!input.isResident) {
    return {
      normal: round2(normalTaxable * 0.3),
      additional: round2(arTaxable * 0.3),
      total: round2((normalTaxable + arTaxable) * 0.3),
    }
  }

  // Resident.
  const monthsRemainingIncludingThis = Math.max(
    1,
    13 - clamp(input.periodMonth, 1, 12),
  )
  const futureMonths = monthsRemainingIncludingThis - 1

  // Annualised normal taxable income — projects this month's level
  // forward to year-end.
  const annualTaxable =
    input.ytdTaxable + normalTaxable + normalTaxable * futureMonths

  // Annualised EPF on normal pay, capped at RM 4,000.
  const annualEpfNormal = Math.min(
    EPF_RELIEF_CAP,
    input.ytdEpf + input.thisMonthEpf + input.thisMonthEpf * futureMonths,
  )

  // Annualised EPF when AR is included — the AR EPF is a one-shot
  // contribution this month, not projected forward.
  const arEpf = Math.max(0, input.thisMonthEpfFromAR ?? 0)
  const annualEpfWithAr = Math.min(
    EPF_RELIEF_CAP,
    input.ytdEpf +
      input.thisMonthEpf +
      input.thisMonthEpf * futureMonths +
      arEpf,
  )

  const reliefs = calcResidentReliefs(input.profile)

  // Chargeable income — without and with the AR.
  const chargeableNormal = Math.max(0, annualTaxable - annualEpfNormal - reliefs)
  const chargeableWithAr = Math.max(
    0,
    annualTaxable + arTaxable - annualEpfWithAr - reliefs,
  )

  const annualTaxNormal = applyResidentTaxBands(chargeableNormal)
  const annualTaxWithAr = applyResidentTaxBands(chargeableWithAr)

  // PCB on normal remuneration: balance owed for the year, spread.
  const stillOwedNormal = Math.max(0, annualTaxNormal - input.ytdPcb)
  const pcbNormal = stillOwedNormal / monthsRemainingIncludingThis

  // PCB on additional remuneration: the marginal tax of layering the
  // AR onto the annual chargeable income. No forward projection — a
  // one-shot.
  const pcbAdditional = Math.max(0, annualTaxWithAr - annualTaxNormal)

  return {
    normal: round2(pcbNormal),
    additional: round2(pcbAdditional),
    total: round2(pcbNormal + pcbAdditional),
  }
}

// ─── Tiny helpers ────────────────────────────────────────────────────────

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
