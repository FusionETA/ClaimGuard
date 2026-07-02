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

// Tiny local helper — same as `round2` in `calc.ts` but kept local to
// avoid a circular import (calc.ts imports calcPcb/calcPcbBreakdown
// from here).
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

// Truncate (toward zero) to 2dp. Used wherever LHDN convention is to
// drop fractional sen rather than round — e.g. K2 (3,549/11 = 322.6363…
// → 322.63), Current Month PCB before 5-sen rounding (15.0958 → 15.09).
// Matches Payroll Panda's display convention.
//
// NOTE on IEEE 754: the naive `Math.trunc(n * 100) / 100` is unsafe for
// "clean" 2dp values because the float representation drifts. For
// example, `32.55 * 100 = 3254.9999999999995` in JS, so the naive
// version returns 32.54 — that's where the SOCSO + EIS = 32.55 figure
// silently became 32.54 on the LHDN-form PDF. We go through `toFixed`
// for a fixed-precision string representation (no drift past the 10th
// decimal) and lexically slice to 2dp.
export function trunc2(n: number): number {
  if (!Number.isFinite(n)) return 0
  const negative = n < 0
  const abs = Math.abs(n)
  const str = abs.toFixed(10)
  const dotIdx = str.indexOf(".")
  if (dotIdx === -1) return n
  const truncated = Number(str.slice(0, dotIdx + 3))
  return negative ? -truncated : truncated
}

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
 * Annual tax rebate (LHDN MTD Spec for 2026, Table 1 Note).
 * The rebate is allowed only when annual chargeable income (P)
 * is ≤ RM 35,000.
 *
 *   - Category 1 (single) and Category 3 (married, spouse working,
 *     divorced, or widowed): RM 400 individual rebate.
 *   - Category 2 (married, spouse not working): RM 400 individual +
 *     RM 400 spouse = RM 800.
 *
 * LHDN bakes this rebate into the `B` column of Table 1 — the
 * negative `B` values for the 5,001-20,000 and 20,001-35,000 bands
 * encode "marginal tax minus rebate" so the formula
 * `(P-M)R + B` gives the post-rebate annual tax in one step. Our
 * implementation does the same arithmetic but separates the two
 * steps for clarity: marginal-band tax, then rebate subtraction.
 *
 * Above RM 35,000 chargeable income the rebate is NOT allowed and
 * Table 1's `B` values are positive (cumulative marginal tax up to
 * the band start).
 */
const REBATE_THRESHOLD = 35000
const REBATE_INDIVIDUAL = 400
const REBATE_SPOUSE = 400 // claimed alongside individual when spouseClaimable

/**
 * Apply LHDN's progressive resident bands to an annual chargeable
 * income, then subtract the individual / spouse rebate (capped at
 * the tax amount, can't go negative). Returns annual tax owed in
 * RM.
 *
 *   - `chargeableIncome` (P): annual taxable income after EPF +
 *     reliefs.
 *   - `spouseClaimable`: true when the employee can claim the spouse
 *     rebate (married AND spouse has no income; same gate as the
 *     RM 4,000 S relief). When true the rebate doubles to RM 800.
 *
 * Negative or zero income returns 0.
 */
export function applyResidentTaxBands(
  chargeableIncome: number,
  spouseClaimable: boolean = false,
): number {
  if (!Number.isFinite(chargeableIncome) || chargeableIncome <= 0) return 0
  let tax = 0
  let prevBound = 0
  for (const band of RESIDENT_TAX_BANDS_2024) {
    if (chargeableIncome <= band.upperBound) {
      tax += (chargeableIncome - prevBound) * band.rate
      break
    }
    tax += (band.upperBound - prevBound) * band.rate
    prevBound = band.upperBound
  }
  // Individual rebate (LHDN cat 1/3 = RM 400; cat 2 = RM 800).
  // Applied only when annual chargeable income ≤ RM 35,000.
  //
  // The threshold check uses `Math.floor(chargeableIncome)` so that
  // sub-ringgit drift from the LHDN K decomposition (K1 + trunc2(K2)×n
  // loses ~0.07 of EPF-cap utilisation) doesn't push a boundary case
  // (e.g. RM 4,000/mo single → strict chargeable = 35,000.07) over
  // the line and silently strip the rebate. The actual tax math
  // below still uses the raw decimal chargeable.
  if (Math.floor(chargeableIncome) <= REBATE_THRESHOLD) {
    const rebate =
      REBATE_INDIVIDUAL + (spouseClaimable ? REBATE_SPOUSE : 0)
    tax -= rebate
  }
  return Math.max(0, tax)
}

// ─── Reliefs ─────────────────────────────────────────────────────────────

/**
 * Per-child relief amounts per LHDN PCB Specification for 2026
 * (Section E, "Reliefs", pages 26-28):
 *
 *   - Child under 18 OR studying (school): RM 2,000
 *   - Child 18+ in higher-ed (diploma+ in Malaysia / degree+ overseas):
 *     RM 8,000 (treated as 4 children of RM 2,000)
 *   - Disabled child (under or over 18, not studying higher-ed):
 *     RM 8,000 (treated as 4 children of RM 2,000)
 *   - Disabled child AND in higher-ed (diploma+):
 *     RM 16,000 (treated as 8 children of RM 2,000)
 *
 * Half-relief (when PCB share is HALF) halves the figures — happens
 * when both parents claim 50/50.
 *
 * Exported so the annual data loader (CP8D / Form EA) can compute the
 * yearly relief total without re-implementing the rules.
 */
export function reliefForChild(child: ChildRelief): number {
  if (child.pcbDeduction === "NONE") return 0
  const isDisabled = child.abilityStatus === "DISABLED"
  const isHigherEd = child.currentlyStudying === "HIGHER_ED"
  let total: number
  if (isDisabled && isHigherEd) {
    // Both — treated as 8 children @ RM 2,000 per LHDN spec.
    total = 16000
  } else if (isDisabled || isHigherEd) {
    // Either one — treated as 4 children @ RM 2,000 per LHDN spec.
    total = 8000
  } else {
    // Below 18, or in primary/secondary school.
    total = 2000
  }
  return child.pcbDeduction === "HALF" ? Math.round((total / 2) * 100) / 100 : total
}

/**
 * Annual personal + family reliefs for a resident employee per LHDN
 * PCB Specification for 2026, Section E Compulsory Deductions
 * (pages 26-29):
 *
 *   - D (Individual)          : RM  9,000
 *   - S (Husband / Wife)      : RM  4,000  (only when spouse not working)
 *   - DU (Disabled individual): RM  7,000  (on top of D)
 *   - SU (Disabled spouse)    : RM  6,000  (on top of S)
 *   - QC (per-child relief)   : via reliefForChild()
 *
 * EPF relief is added on top by the orchestrator (capped at RM 4,000).
 */
export function calcResidentReliefs(profile: {
  isOku: boolean
  spouseWorking: boolean | null
  spouseDisabled: boolean | null
  childRelief: ChildRelief[]
}): number {
  return calcResidentReliefsBreakdown(profile).total
}

/**
 * Itemised view of `calcResidentReliefs`. Used by the admin UI to
 * preview what reliefs will be applied to the next payroll run.
 */
export type ResidentReliefsBreakdown = {
  /// D — RM 9,000 individual relief (always applied to residents).
  individual: number
  /// DU — RM 7,000 disabled-individual relief (only when isOku).
  disabledIndividual: number
  /// S — RM 4,000 spouse relief (only when spouseWorking === false).
  spouse: number
  /// SU — RM 6,000 disabled-spouse relief (only when spouseWorking ===
  /// false AND spouseDisabled === true).
  disabledSpouse: number
  /// Sum of per-child reliefs.
  children: number
  /// Per-child amounts in the same order as `profile.childRelief`.
  childItems: number[]
  /// Sum of all components above.
  total: number
}

export function calcResidentReliefsBreakdown(profile: {
  isOku: boolean
  spouseWorking: boolean | null
  spouseDisabled: boolean | null
  childRelief: ChildRelief[]
}): ResidentReliefsBreakdown {
  const individual = 9000
  const disabledIndividual = profile.isOku ? 7000 : 0
  const spouseClaimable = profile.spouseWorking === false
  const spouse = spouseClaimable ? 4000 : 0
  const disabledSpouse =
    spouseClaimable && profile.spouseDisabled === true ? 6000 : 0
  const childItems = profile.childRelief.map(reliefForChild)
  const children = childItems.reduce((acc, v) => acc + v, 0)
  const total =
    individual + disabledIndividual + spouse + disabledSpouse + children
  return {
    individual,
    disabledIndividual,
    spouse,
    disabledSpouse,
    children,
    childItems,
    total,
  }
}

// ─── EPF relief cap ─────────────────────────────────────────────────────

export const EPF_RELIEF_CAP = 4000

// ─── SOCSO + EIS + SKBBK relief cap ─────────────────────────────────────

/**
 * Combined PERKESO (SOCSO + EIS + SKBBK) employee-contribution relief,
 * capped at RM 350 per year of assessment. SKBBK (Skim Keselamatan
 * Bersepadu Pekerja Bebas, eff. 1 Jun 2026) is a PERKESO scheme and
 * shares the same RM 350 relief bucket — confirmed against Payroll
 * Panda's 2026 rollout (their "SOCSO" PCB-relief input = SOCSO + SKBBK
 * employee).
 *
 * **Classification.** Strictly per LHDN MTD Specification 2026 this is
 * a TP1 (optional) deduction — the employee should submit Form TP1 to
 * the employer if they want it applied to monthly PCB; otherwise it
 * gets claimed back via the year-end Form e-BE. We auto-apply it
 * anyway, the same way HReasily / BrioHR / Talenox do, because the
 * employer already deducts and knows the exact SOCSO + EIS amount
 * (zero information asymmetry → no employee-declaration step needed).
 * The cap of RM 350 is small enough that the over-claim risk is nil:
 * an employee earning the wage ceiling for both schemes contributes
 * RM 88.85 SOCSO + RM 9.90 EIS = ~RM 98.75 / month, well above the
 * cap, so we'll always converge on RM 350 by mid-year.
 *
 * The relief stacks alongside EPF (also auto-applied, capped at RM
 * 4,000) and the compulsory family reliefs (D / S / DU / SU / QC).
 * TP1 items that the employer has NO way of knowing (life insurance,
 * lifestyle, parents' medical, etc.) remain employee-declared and are
 * out of scope for v1.
 *
 * **Projection style: actuals-only.** Unlike EPF (which uses LHDN's
 * forward-projection formula `ytd + thisMonth + thisMonth × futureMonths`
 * then caps at RM 4,000), SOCSO + EIS relief is computed from
 * **actual contributions paid to date** — `ytd + thisMonth` only,
 * capped at RM 350. Matches HReasily / BrioHR / Talenox. Annual PCB
 * total ends up identical to a projected approach; only the per-
 * month distribution differs (relief grows until the cap is reached
 * mid-year, instead of being applied in full from January).
 */
export const SOCSO_EIS_RELIEF_CAP = 350

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
  /// PayrollProfile.prevRemuneration + prevEpf + prevPcb + prevZakat
  /// (caller adds these in).
  ytdTaxable: number
  ytdEpf: number
  ytdPcb: number
  /// Z in the LHDN formula: accumulated zakat paid in the current
  /// year, EXCLUDING zakat for the current month (which is offset by
  /// the orchestrator after `calcPcb` returns). The annual tax owed
  /// is reduced by Z because zakat fully offsets MTD obligation. Pass
  /// 0 if no zakat history. Defaults to 0 so legacy callers keep
  /// working unchanged.
  ytdZakat?: number
  /// This month's SOCSO + EIS employee contribution (from normal
  /// pay). Defaults to 0 so legacy callers keep working unchanged.
  /// Used in the actuals-only relief calc: `min(RM 350, YTD + thisMonth)`
  /// — no forward projection.
  thisMonthSocsoEis?: number
  /// YTD SOCSO + EIS employee contributions (sum of socsoEmployee +
  /// eisEmployee from prior SUBMITTED payslips this calendar year,
  /// excluding the current month). Defaults to 0. The actuals-only
  /// relief = `min(RM 350, ytd + thisMonth)`.
  ytdSocsoEis?: number
  /// This month's TP1-declared allowable deductions (life insurance,
  /// medical/education insurance, PRS, serious-disease medical,
  /// lifestyle, sports equipment, other). Summed from line items with
  /// `feedsLp1Relief: true`, with each item's amount already clamped
  /// to its per-item LHDN cap by the caller (see calc.ts). Feeds LP1
  /// in the formula: `P = [income] - (D + S + Du + Su + QC + ∑LP + LP1)`.
  /// Defaults to 0.
  thisMonthAllowableDeductions?: number
  /// YTD TP1 allowable deductions carried over from prior SUBMITTED
  /// payslips this calendar year (this org), PLUS the prior-employer
  /// figure from PayrollProfile.prevAllowableDeductions when the
  /// employee joined mid-year (parallels the existing prev*
  /// carryover for taxable/EPF/PCB/zakat). Feeds ∑LP in the formula.
  /// Defaults to 0.
  ytdAllowableDeductions?: number
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
  // split the result so the caller can report it correctly. The
  // RM 10 minimum-deduction threshold applies on each component
  // (LHDN MTD Spec for 2026, Section E item 3).
  if (!input.isResident) {
    const nrNormal = applyMtdThreshold(roundMtd(normalTaxable * 0.3))
    const nrAdditional = applyMtdThreshold(roundMtd(arTaxable * 0.3))
    return {
      normal: nrNormal,
      additional: nrAdditional,
      total: roundMtd(nrNormal + nrAdditional),
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

  // Annualised normal EPF, using the LHDN K1 + trunc2(K2)×n
  // decomposition (matches the PCB walkthrough PDF + Payroll Panda).
  //
  //   K  = min(4K, ytdEpf)
  //   K1 = min(ceil(thisMonthEpf), remaining_cap)        — whole RM, LHDN convention
  //   K2 = trunc2(min(thisMonthEpf, remaining_cap / n))  — 2dp per LHDN spec
  //   annualEpfNormal = K + K1 + K2 × n
  //
  // Previously this used the simpler `ytdEpf + thisMonthEpf × (1 + n)`
  // capped at RM 4,000. That saturated the cap EXACTLY (e.g. 4,000.00)
  // while the LHDN form's decomposition lands at 3,999.93 — a 0.07
  // gap that compounded through chargeable income → tax bracket → PCB,
  // making the engine's `payslip.pcb` disagree with its own
  // `pcbCalculation` JSON by up to 10 sen (admins reported Sharizan
  // Jan-2026: app row 2,247.50 vs PDF 2,247.40).
  //
  // Now both paths share the same EPF figures and produce the same
  // final total. The known boundary case (RM 4,000/mo Cat 1 single
  // employee — chargeable lands at 35,000 exactly under the simple
  // formula vs 35,000.07 under decomposition, missing the RM 400
  // rebate by sub-cent) is handled by `rebateBoundaryNudge` below.
  const arEpf = Math.max(0, input.thisMonthEpfFromAR ?? 0)
  const K_relief = Math.min(EPF_RELIEF_CAP, Math.max(0, input.ytdEpf))
  const cap_after_K_relief = Math.max(0, EPF_RELIEF_CAP - K_relief)
  const K1_relief = Math.min(
    Math.ceil(Math.max(0, input.thisMonthEpf)),
    cap_after_K_relief,
  )
  const cap_after_K1_relief = Math.max(0, cap_after_K_relief - K1_relief)
  const K2_relief =
    futureMonths > 0
      ? trunc2(
          Math.min(
            Math.max(0, input.thisMonthEpf),
            cap_after_K1_relief / futureMonths,
          ),
        )
      : 0
  const cap_after_K1_K2_relief = Math.max(
    0,
    cap_after_K1_relief - K2_relief * futureMonths,
  )
  const Kt_relief = Math.min(arEpf, cap_after_K1_K2_relief)
  const annualEpfNormal = K_relief + K1_relief + K2_relief * futureMonths
  const annualEpfWithAr = annualEpfNormal + Kt_relief

  const reliefs = calcResidentReliefs(input.profile)
  const ytdZakat = Math.max(0, input.ytdZakat ?? 0)

  // SOCSO + EIS relief — actuals-only (NOT projected forward like EPF).
  //
  // K2 = min(RM 350, YTD_SOCSO_EIS + thisMonth_SOCSO_EIS)
  //
  // Matches HReasily / BrioHR / Talenox: we only credit contributions
  // already paid, not a forward projection. The relief grows month-
  // by-month until the RM 350 cap is reached (typically mid-year for
  // wages above ~RM 4,000). Annual PCB total ends up identical to
  // the projected approach — only the per-month distribution differs.
  //
  // Auto-applied (see SOCSO_EIS_RELIEF_CAP doc comment for why we
  // don't gate this behind Form TP1). Defaults to 0 when the caller
  // doesn't pass the SOCSO/EIS figures (legacy callers and non-
  // resident path remain unaffected).
  const thisMonthSocsoEis = Math.max(0, input.thisMonthSocsoEis ?? 0)
  const ytdSocsoEis = Math.max(0, input.ytdSocsoEis ?? 0)
  const annualSocsoEisRelief = Math.min(
    SOCSO_EIS_RELIEF_CAP,
    ytdSocsoEis + thisMonthSocsoEis,
  )

  // TP1 declared allowable deductions (life insurance, medical
  // insurance, PRS, serious-disease medical, lifestyle, sports
  // equipment, other). These feed ∑LP + LP1 in the LHDN formula,
  // same bucket as SOCSO+EIS but with NO combined cap — each item
  // was already clamped to its per-item LHDN cap by the caller
  // (see `feedsLp1Relief` handling in calc.ts). Matches
  // `calcPcbBreakdown` below.
  //
  // Previously `calcPcb` silently ignored these two inputs, so
  // `Payslip.pcb` (which is written from calcPcb's result) never
  // reflected TP1 relief — even though `Payslip.pcbCalculation`
  // (from `calcPcbBreakdown`) did. Admins would add a TP1
  // adjustment, re-run payroll, and see the PCB column unchanged
  // while the detailed LHDN breakdown PDF showed a different,
  // correctly-relieved number.
  const sumLPTp1 = Math.max(0, input.ytdAllowableDeductions ?? 0)
  const LP1Tp1 = Math.max(0, input.thisMonthAllowableDeductions ?? 0)
  const annualAllowableDeductions = sumLPTp1 + LP1Tp1

  // LHDN individual rebate doubles to RM 800 when the spouse has no
  // income (Category 2). Same gate as the RM 4,000 S relief, applied
  // both here (rebate) and in calcResidentReliefs (deduction).
  const spouseClaimable = input.profile.spouseWorking === false

  // Chargeable income — without and with the AR. EPF + SOCSO/EIS
  // relief both come off the annual taxable income alongside the
  // personal/family reliefs.
  const chargeableNormal = Math.max(
    0,
    annualTaxable -
      annualEpfNormal -
      annualSocsoEisRelief -
      annualAllowableDeductions -
      reliefs,
  )
  const chargeableWithAr = Math.max(
    0,
    annualTaxable +
      arTaxable -
      annualEpfWithAr -
      annualSocsoEisRelief -
      annualAllowableDeductions -
      reliefs,
  )

  const annualTaxNormal = applyResidentTaxBands(
    chargeableNormal,
    spouseClaimable,
  )
  const annualTaxWithAr = applyResidentTaxBands(
    chargeableWithAr,
    spouseClaimable,
  )

  // PCB on normal remuneration: balance owed for the year, spread.
  // Per LHDN formula `MTD = [(P-M)R + B - (Z + X)] / (n+1)`, we
  // subtract Z (accumulated YTD zakat) AND X (accumulated YTD PCB)
  // from the annual tax before dividing across remaining months.
  const stillOwedNormal = Math.max(
    0,
    annualTaxNormal - ytdZakat - input.ytdPcb,
  )
  const pcbNormal = stillOwedNormal / monthsRemainingIncludingThis

  // LHDN MTD Spec Section E in one place (pages 19-20):
  //
  //   1. Truncate each component to 2dp (`trunc2`).
  //   2. Zero anything below RM 10 — per component, not on the sum
  //      (`applyMtdThreshold`).
  //   3. Round up to the next 5 sen, ONCE, on the final Net PCB
  //      (`roundMtd`).
  //
  //   PCB(A)  = trunc2(currentMonthPcb), thresholded.
  //   PCB(B)  = X + PCB(A) × (n + 1)            — projection only.
  //   PCB(C)  = trunc2(CS − PCB(B) − Z), thresholded; 0 when no AR.
  //   Net PCB = roundMtd(PCB(A) + PCB(C))
  //
  // We deliberately do NOT 5-sen-ceil PCB(A) or PCB(C) before the
  // sum — that's double rounding and pushes 155.99 (which should
  // ceil to 156.00) up to 156.05.
  const pcbA = applyMtdThreshold(trunc2(pcbNormal))
  const pcbB = input.ytdPcb + trunc2(pcbNormal) * monthsRemainingIncludingThis
  const pcbCBeforeRounding = Math.max(0, annualTaxWithAr - pcbB - ytdZakat)
  const pcbC = applyMtdThreshold(trunc2(pcbCBeforeRounding))

  return {
    normal: pcbA,
    additional: pcbC,
    total: roundMtd(pcbA + pcbC),
  }
}

// ─── Tiny helpers ────────────────────────────────────────────────────────

/**
 * Apply LHDN's MTD rounding rule (Section E items 1-2, page 19 of
 * the 2026 spec):
 *
 *   1. Calculation is limited to two decimal points; subsequent
 *      figures are OMITTED (truncated, not rounded).
 *      Example: 123.4534 → 123.45
 *   2. The amount is then rounded UP to the nearest 5 cents:
 *      - 1/2/3/4 cents → 5 cents (e.g. 287.02 → 287.05)
 *      - 6/7/8/9 cents → 10 cents (e.g. 152.06 → 152.10)
 *      (0 and 5 are already on a 5-cent boundary and stay put.)
 *
 * Negative or non-finite inputs collapse to 0.
 */
export function roundMtd(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  const cents = Math.floor(n * 100) // truncate to 2 dp
  const rounded = Math.ceil(cents / 5) * 5 // round up to 5-cent step
  return rounded / 100
}

/**
 * Apply LHDN's RM 10 minimum-deduction threshold (Section E items 3 &
 * 4, page 19-20):
 *
 *   - Normal MTD or AR MTD < RM 10 (before zakat) → not required to
 *     be deducted (set to 0).
 *
 * The "Net MTD after zakat < RM 10 is still deducted" rule is
 * handled by the orchestrator at the zakat-offset step — we
 * deliberately do NOT zero out the offset result here.
 */
function applyMtdThreshold(mtd: number): number {
  if (mtd < 10) return 0
  return mtd
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

// ─── PCB breakdown (LHDN-style line-by-line) ────────────────────────────

/**
 * LHDN MTD Specification Table 1 in our band shape: walk the bands and
 * return the {M, R, B} triple for the band that contains `P`. M is the
 * lower bound of the bracket (in RM), R is its marginal rate, and B is
 * the cumulative tax at M minus the rebate (when P ≤ RM 35,000), so the
 * LHDN formula `(P - M) × R + B` yields the post-rebate annual tax in
 * one step.
 */
function findResidentTaxBand(
  P: number,
  spouseClaimable: boolean,
): { M: number; R: number; B: number } {
  if (!Number.isFinite(P) || P <= 0) {
    return { M: 0, R: 0, B: 0 }
  }
  let prevBound = 0
  let cumulativeTaxAtPrevBound = 0
  for (const band of RESIDENT_TAX_BANDS_2024) {
    if (P <= band.upperBound) {
      let B = cumulativeTaxAtPrevBound
      if (P <= REBATE_THRESHOLD) {
        const rebate =
          REBATE_INDIVIDUAL + (spouseClaimable ? REBATE_SPOUSE : 0)
        B -= rebate
      }
      return { M: prevBound, R: band.rate, B }
    }
    cumulativeTaxAtPrevBound += (band.upperBound - prevBound) * band.rate
    prevBound = band.upperBound
  }
  // Above the top band (very rare — chargeable income > RM 2M).
  return { M: prevBound, R: 0.3, B: cumulativeTaxAtPrevBound }
}

/**
 * Full LHDN-style breakdown of a single resident PCB(A) computation.
 * Variables use the exact symbols from the LHDN MTD Specification so
 * the rendered PDF mirrors LHDN's Form CP 39 explanation:
 *
 *   - Y / K           — accumulated YTD gross / EPF (prior months,
 *                       including any AR-EPF that was already paid)
 *   - Σ(Y-K)          — Y minus K (accumulated NET remuneration)
 *   - Y1 / K1         — current month's normal gross / EPF (K1
 *                       capped at the remaining RM 4,000 budget)
 *   - Y2 / K2         — estimated future months (per LHDN rules:
 *                       Y2 = Y1 × n, K2 = min(K1, remainingCap/n))
 *   - n               — remaining working months (excludes current)
 *   - D / S / Du / Su — personal / spouse / disabled-individual /
 *                       disabled-spouse reliefs
 *   - Q × C           — per-child amount times child count
 *   - ∑LP / LP1       — accumulated / current allowable other
 *                       deductions (we use SOCSO+EIS today)
 *   - P               — annual chargeable income (no AR)
 *   - M / R / B       — tax band for P
 *   - Z / X           — accumulated zakat / accumulated PCB paid
 *   - yearlyTax       — (P - M) × R + B
 *   - currentMonthPcb — (yearlyTax - Z - X) / (n + 1)
 *
 * V1 covers the resident PCB(A) only — non-resident uses the simple
 * flat-30% block and AR (PCB B / C) is omitted from the breakdown
 * (the calcPcb total still includes AR PCB; we just don't show the
 * formula). Add AR when a customer needs it.
 */
export type CalcPcbBreakdown =
  | {
      formula: "nonResident"
      rate: number // 0.30
      normalTaxable: number
      normalPcb: number
      additionalTaxable: number
      additionalPcb: number
      totalPcb: number
    }
  | {
      formula: "resident"
      Y: number
      K: number
      sumYK: number // Y - K
      Y1: number
      K1: number
      Y2: number
      K2: number
      n: number
      // Reliefs
      D: number
      S: number
      Du: number
      Su: number
      Q: number // per-child amount actually used (display as RM 2,000 by default)
      C: number // number of children that produced relief
      QC: number // total per-child relief (Σ reliefForChild)
      sumLP: number
      LP1: number
      // Annual chargeable income (no AR)
      P: number
      // Tax band for P
      M: number
      R: number
      B: number
      // Accumulated
      Z: number
      X: number
      zakatThisMonth: number
      // PCB(A) outputs
      yearlyTax: number // (P - M) × R + B
      currentMonthPcb: number // (yearlyTax - Z - X) / (n + 1), before threshold + rounding
      pcbAfterThreshold: number // 0 if currentMonthPcb < RM 10
      pcbFinal: number // rounded up to 5 cents (PCB(A) + PCB(B) combined)
      // Additional Remuneration breakdown — per LHDN MTD Specification
      // 2026 Section E. The LHDN spec walks five sub-steps:
      //
      //   Section 1 — PCB(A) = current month normal PCB (above)
      //   Section 2 — PCB(B) = projected ANNUAL normal PCB
      //               = X + PCB(A) × (n + 1)
      //   Section 3 — CS = yearly tax WITH AR
      //               = (P_withAR − M_withAR)R_withAR + B_withAR
      //   Section 4 — PCB(C) = additional remuneration PCB
      //               = CS − PCB(B) − Z
      //   Section 5 — PCB(MTD) = PCB(A) + PCB(C), rounded up to 5c
      //
      // All zeros when no AR fires this run (treatAsRecurring=true or
      // no AR-categorised line).
      ar: {
        // ── Section 3 — Yearly Tax (CS) primitives ──
        Yt: number // additional remuneration this month (bonus / commission / arrears, taxable)
        // Full EPF contribution on the AR amount as actually paid by
        // the employee (= ceil(Yt × employee mandatory rate)). Matches
        // the LHDN form's expected meaning of Kt and the engine's
        // employee EPF total.
        Kt: number
        // The portion of Kt that actually counts as tax relief —
        // capped against the remaining RM 4,000 annual budget after
        // K + K1 + (K2 × n). Often near zero when the normal
        // projection already saturates the cap. Used in the LHDN-form
        // PDF's P (with AR) formula expansion so the displayed math
        // reconciles (the simple `P + Yt - Kt` reading uses 134; the
        // actual chargeable subtracts only this effective value).
        KtEffective: number
        // P_withAR — annual chargeable income with the AR layered on
        chargeableWithAr: number
        // Tax band for the with-AR chargeable. Differs from Section 1's
        // M / R / B only when AR pushes the chargeable past a bracket
        // boundary. Labelled M₂/R₂/B₂ in the PDF.
        M2: number
        R2: number
        B2: number
        // CS — yearly tax with AR = (P_withAR − M₂)R₂ + B₂
        CS: number
        // ── Section 2 — PCB(B), the annual NORMAL projection ──
        // PCB(B) = X + PCB(A) × (n + 1)
        pcbB: number
        // ── Section 4 — PCB(C), the AR marginal increase ──
        // PCB(C) = CS − PCB(B) − Z (before threshold + 5c rounding)
        pcbCBeforeRounding: number
        // After LHDN MTD threshold + 5c rounding
        pcbC: number
        // ── Section 5 — Net PCB this month ──
        // = round-up-to-5c(PCB(A) + PCB(C)). Should equal `pcbFinal`
        // above; duplicated here so the PDF's Section 5 line ties out
        // without the reader needing to chase it.
        pcbCurrentMonth: number
      }
      // Legacy single-number AR field — kept so older snapshot readers
      // don't break. Always equals `ar.pcbC` for new payslips.
      pcbAdditional: number // 0 when no AR this month
    }

/**
 * Build the LHDN-style breakdown for display. Mirrors `calcPcb`'s
 * internal arithmetic — keep these two in sync if you ever change the
 * formula. The returned numbers match `calcPcb`'s outputs exactly
 * (within floating-point) so the PDF row and the deducted amount can
 * never disagree.
 *
 * Persist this on the payslip at generation time (see
 * `PayrollPayslip.pcbBreakdown` in the Prisma schema). The Detailed
 * Calculations PDF reads from that snapshot so historical runs always
 * show the formula that produced the actual deducted PCB.
 */
export function calcPcbBreakdown(input: CalcPcbInput): CalcPcbBreakdown {
  const normalTaxable = Math.max(0, input.thisMonthTaxable)
  const arTaxable = Math.max(0, input.thisMonthAdditionalRemuneration ?? 0)

  if (!input.isResident) {
    const nrNormal = applyMtdThreshold(roundMtd(normalTaxable * 0.3))
    const nrAdditional = applyMtdThreshold(roundMtd(arTaxable * 0.3))
    return {
      formula: "nonResident",
      rate: 0.3,
      normalTaxable,
      normalPcb: nrNormal,
      additionalTaxable: arTaxable,
      additionalPcb: nrAdditional,
      totalPcb: roundMtd(nrNormal + nrAdditional),
    }
  }

  // ── Resident — mirrors calcPcb's resident branch step-by-step. ──
  const monthsRemainingIncludingThis = Math.max(
    1,
    13 - clamp(input.periodMonth, 1, 12),
  )
  const n = monthsRemainingIncludingThis - 1

  // LHDN-style K split (K = YTD, K1 = this month, K2 = projected future).
  // All capped against the RM 4,000 EPF-relief budget. Each step
  // subtracts what's already used:
  //
  //   K  ≤ 4K
  //   K1 ≤ 4K − K
  //   K2 ≤ (4K − K − K1) ÷ n   ← per-month cap
  //   Kt ≤ 4K − K − K1 − K2×n  ← AR EPF takes WHATEVER cap remains
  //                              after the normal-side projection
  //                              has had first claim
  //
  // Earlier this routine subtracted Kt from K2's cap, which meant the
  // normal-side PCB(A) understated by (Kt × R) and PCB(B) overstated
  // by the same amount. Net deducted PCB stayed roughly right but the
  // breakdown numbers didn't reconcile against the actual deducted
  // amount. Fixed by computing K2 first (no Kt subtraction), then
  // sizing Kt against whatever cap is left.
  const K = Math.min(EPF_RELIEF_CAP, Math.max(0, input.ytdEpf))
  const cap_after_K = Math.max(0, EPF_RELIEF_CAP - K)
  const thisMonthEpf = Math.max(0, input.thisMonthEpf)
  // K1 is displayed on the LHDN form as a WHOLE-RINGGIT figure (per
  // the Spec's "rounded up to the next ringgit" convention for EPF
  // contributions). Payroll Panda follows this. We ceil here so the
  // displayed K1 matches — K2 then naturally absorbs the few sen
  // difference within the same RM 4,000 cap. Next month's run reads
  // the ACTUAL EPF paid (from the payslip snapshot), not the ceil'd
  // K1, so no drift accumulates.
  const K1 = Math.min(Math.ceil(thisMonthEpf), cap_after_K)
  const cap_after_K1 = Math.max(0, EPF_RELIEF_CAP - K - K1)
  // Truncate K2 at 2dp (LHDN / Payroll Panda convention — don't round).
  // 3,549 / 11 = 322.6363… → 322.63. Stored exactly as displayed, so
  // an auditor doing the formula by hand produces the same P /
  // Yearly Tax / Current Month PCB the engine deducted. `calcPcb`
  // uses the same trunc2 above for symmetry.
  const K2 = n > 0 ? trunc2(Math.min(thisMonthEpf, cap_after_K1 / n)) : 0
  // AR EPF deductible — only what fits into the cap AFTER normal K2×n
  // has been booked. When the normal side already hits 4K, Kt = 0
  // (the AR contribution still happens in real life, it just gets no
  // additional tax relief).
  const cap_after_K1_K2 = Math.max(0, EPF_RELIEF_CAP - K - K1 - K2 * n)
  const Kt = Math.min(
    Math.max(0, input.thisMonthEpfFromAR ?? 0),
    cap_after_K1_K2,
  )

  const Y = Math.max(0, input.ytdTaxable)
  const Y1 = normalTaxable
  const Y2 = Y1 * n

  const sumYK = Y - K // accumulated NET

  // Reliefs (LHDN: D, S, Du, Su, Q×C).
  const r = calcResidentReliefsBreakdown(input.profile)
  const D = r.individual
  const S = r.spouse
  const Du = r.disabledIndividual
  const Su = r.disabledSpouse
  const QC = r.children
  // Q and C: the LHDN form shows them separately for display.
  // We don't have the per-child rate in the breakdown (it varies per
  // child — RM 2k / 8k / 16k); use a synthetic "Q = RM 2,000" as the
  // base amount and "C = QC / 2000" so the math reads sensibly.
  // When children mix non-standard amounts, Q × C may differ from QC —
  // we always report the actual QC sum for accuracy.
  const Q = 2000
  const C = QC > 0 ? Math.round((QC / Q) * 100) / 100 : 0

  // ∑LP + LP1 = two components summed:
  //   (a) SOCSO + EIS + SKBBK actuals-only relief (capped at RM 350
  //       combined per year — see SOCSO_EIS_RELIEF_CAP).
  //   (b) TP1-declared allowable deductions (life insurance, medical
  //       insurance, PRS, etc.) — NO combined cap (each item is
  //       already clamped to its per-item LHDN cap by the caller).
  //
  // Both go into LP1 (current month) + ∑LP (accumulated) as per LHDN
  // MTD Spec 2026 page 10.
  const sumLPSocsoEis = Math.min(
    SOCSO_EIS_RELIEF_CAP,
    Math.max(0, input.ytdSocsoEis ?? 0),
  )
  const LP1SocsoEis = Math.max(
    0,
    Math.min(
      Math.max(0, input.thisMonthSocsoEis ?? 0),
      Math.max(0, SOCSO_EIS_RELIEF_CAP - sumLPSocsoEis),
    ),
  )
  const sumLPTp1 = Math.max(0, input.ytdAllowableDeductions ?? 0)
  const LP1Tp1 = Math.max(0, input.thisMonthAllowableDeductions ?? 0)
  const sumLP = sumLPSocsoEis + sumLPTp1
  const LP1 = LP1SocsoEis + LP1Tp1

  // Annual chargeable income — formula exactly per LHDN.
  // P = [Σ(Y-K) + (Y1-K1) + (Y2-K2×n)] - (D + S + Du + Su + Q×C + ∑LP + LP1)
  const annualGrossNet =
    sumYK + (Y1 - K1) + (Y2 - K2 * n)
  const totalReliefs = D + S + Du + Su + QC + sumLP + LP1
  const P = Math.max(0, annualGrossNet - totalReliefs)

  const spouseClaimable = input.profile.spouseWorking === false
  const { M, R, B } = findResidentTaxBand(P, spouseClaimable)

  const yearlyTax = Math.max(0, (P - M) * R + B)

  const Z = Math.max(0, input.ytdZakat ?? 0)
  const X = Math.max(0, input.ytdPcb)

  const stillOwed = Math.max(0, yearlyTax - Z - X)
  const currentMonthPcb = stillOwed / (n + 1)
  // PCB(A) = current-month PCB truncated to 2dp + RM 10 threshold.
  // The 5-sen ceil happens ONCE on the Net PCB sum at the very end
  // — feeding a pre-ceiled PCB(A) into that sum double-rounds and
  // breaks the formula box on the LHDN PDF. See calcPcb above for
  // the same pattern.
  const pcbA = applyMtdThreshold(trunc2(currentMonthPcb))

  // ── Additional Remuneration — LHDN MTD Specification 2026 §E. ──
  //
  // Computed in the exact five-step order the spec walks:
  //
  //   Step 1: PCB(A) — current month normal PCB. Already done above as
  //           `pcbAfterThreshold`.
  //
  //   Step 2: PCB(B) — projected annual NORMAL PCB.
  //           = X + PCB(A) × (n + 1)
  //           This is what the year-end PCB would total if the
  //           employee earned this month's normal PCB every remaining
  //           month and we added the YTD already paid.
  //
  //   Step 3: CS — yearly tax with AR.
  //           = (P_withAR − M₂)R₂ + B₂
  //           where P_withAR = P + AR − Kt   (Kt = AR EPF, capped
  //           against remaining RM 4K relief budget after the normal
  //           K + K₁ + K₂×n)
  //
  //   Step 4: PCB(C) — additional remuneration PCB.
  //           = CS − PCB(B) − Z       (before MTD threshold + 5c)
  //
  //   Step 5: PCB current month = round-up-5c(PCB(A) + PCB(C)).
  //           This is what gets deducted and remitted.
  //
  // Mirrors calcPcb's arithmetic so the displayed numbers match what
  // was actually deducted exactly.
  const Yt = arTaxable
  // Two-value Kt:
  //
  //   ar.Kt (display)        = the FULL EPF contribution on the AR
  //                            amount as actually paid by the
  //                            employee = ceil(Yt × employee rate).
  //                            Matches the LHDN form's expected
  //                            meaning of Kt and reconciles with the
  //                            engine's other EPF outputs (employee
  //                            EPF total 585 = 451 regular + 134 AR
  //                            + 0 voluntary).
  //
  //   KtForRelief (internal) = the portion of Kt that gets PCB
  //                            relief, capped against the remaining
  //                            RM 4,000 budget after normal K + K₁ +
  //                            K₂×n. Used in the chargeable_with_AR
  //                            formula so the deducted PCB stays
  //                            LHDN-compliant.
  //
  // When the normal projection saturates the cap, KtDisplay still
  // shows the contributed amount (e.g. 134), while KtForRelief drops
  // toward 0. That's faithful to KWSP/LHDN: the EPF is still paid,
  // just no extra tax relief.
  const KtDisplay = Math.max(0, input.thisMonthEpfFromAR ?? 0)
  const KtForRelief = Kt // = cap-restricted value computed above
  const chargeableWithAr = Math.max(
    0,
    annualGrossNet + Yt - KtForRelief - totalReliefs,
  )
  const arBand = findResidentTaxBand(chargeableWithAr, spouseClaimable)
  const M2 = arBand.M
  const R2 = arBand.R
  const B2 = arBand.B
  // CS is a tax intermediate (yearly tax including AR), not a PCB
  // value, so the LHDN Section E truncation rule doesn't apply here.
  // Use standard 2dp rounding — matches Payroll Panda's CS display
  // (e.g. Kang Nickee: raw 1,067.127 -> round 1,067.13 instead of
  // truncate 1,067.12). Downstream pcbC then subtracts off the
  // rounded CS so the formula `CS - PCB(B) - Z` printed on the LHDN
  // PDF reconciles to the sen.
  const CS = round2(Math.max(0, (chargeableWithAr - M2) * R2 + B2))
  // PCB(B) — annual projected normal PCB.
  // Uses the TRUNCATED `currentMonthPcb` (e.g. 15.0958 → 15.09) — NOT
  // the 5-sen-rounded `pcbAfterThreshold` (15.10). This matches the
  // LHDN-form PDF row above which displays the truncated value, and
  // matches Payroll Panda's projection (15.09 × 12 = 181.08 instead of
  // 15.10 × 12 = 181.20). Final deducted PCB ends up 469.40 vs the old
  // 469.30 — the truncation-then-multiply path is what every other
  // Malaysian payroll system seems to use.
  const pcbB = X + trunc2(currentMonthPcb) * (n + 1)
  const pcbCBeforeRounding = Math.max(0, CS - pcbB - Z)
  // PCB(C) — 2dp truncation (LHDN Section E item 1) + RM 10
  // threshold (item 3) only. NO 5-sen ceil here — that's reserved
  // for the FINAL Net PCB on the line below. See the matching
  // comment in `calcPcb` for the rationale (the formula box on the
  // LHDN PDF was reading `1,067.12 - 993.96 = 73.16` but printing
  // PCB(C) = 73.20 because of this ceil; admins saw it as a math
  // error). Matches Payroll Panda.
  const pcbC = Yt > 0 ? applyMtdThreshold(trunc2(pcbCBeforeRounding)) : 0
  // Net PCB = ceil-to-5-sen(PCB(A) + PCB(C)). Single rounding step,
  // applied once, at the sum. Matches what an auditor would
  // re-derive by hand from the LHDN-form formula `PCB (A) + PCB (C)`.
  const pcbCurrentMonth = roundMtd(pcbA + pcbC)

  // zakatThisMonth — pcb-orchestrator-level offset, not part of formula
  // body. Captured for completeness in case the UI wants to show it.
  // Caller can leave undefined → 0.
  const zakatThisMonth = 0

  return {
    formula: "resident",
    Y, K, sumYK,
    Y1, K1, Y2, K2, n,
    D, S, Du, Su, Q, C, QC,
    sumLP, LP1,
    P, M, R, B,
    Z, X, zakatThisMonth,
    yearlyTax,
    currentMonthPcb,
    // Kept for backwards-compat with the LHDN PDF data binding —
    // it's PCB(A), just under the legacy name from when the engine
    // 5-sen-ceiled it before this point.
    pcbAfterThreshold: pcbA,
    pcbFinal: pcbCurrentMonth,
    ar: {
      Yt,
      Kt: KtDisplay, // full contributed AR EPF; matches the LHDN form's expected meaning
      KtEffective: KtForRelief, // cap-restricted portion that gets PCB relief
      chargeableWithAr,
      M2,
      R2,
      B2,
      CS,
      pcbB,
      pcbCBeforeRounding,
      pcbC,
      pcbCurrentMonth,
    },
    pcbAdditional: pcbC,
  }
}
