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
  if (chargeableIncome <= REBATE_THRESHOLD) {
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

// ─── SOCSO + EIS relief cap ─────────────────────────────────────────────

/**
 * Combined PERKESO (SOCSO + EIS) employee-contribution relief, capped
 * at RM 350 per year of assessment.
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

  // LHDN individual rebate doubles to RM 800 when the spouse has no
  // income (Category 2). Same gate as the RM 4,000 S relief, applied
  // both here (rebate) and in calcResidentReliefs (deduction).
  const spouseClaimable = input.profile.spouseWorking === false

  // Chargeable income — without and with the AR. EPF + SOCSO/EIS
  // relief both come off the annual taxable income alongside the
  // personal/family reliefs.
  const chargeableNormal = Math.max(
    0,
    annualTaxable - annualEpfNormal - annualSocsoEisRelief - reliefs,
  )
  const chargeableWithAr = Math.max(
    0,
    annualTaxable +
      arTaxable -
      annualEpfWithAr -
      annualSocsoEisRelief -
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

  // PCB on additional remuneration: the marginal tax of layering the
  // AR onto the annual chargeable income. No forward projection — a
  // one-shot.
  const pcbAdditional = Math.max(0, annualTaxWithAr - annualTaxNormal)

  // Apply LHDN rounding + RM 10 minimum-deduction threshold to
  // each component independently (Section E items 1-3, page 19-20).
  const normalRounded = applyMtdThreshold(roundMtd(pcbNormal))
  const arRounded = applyMtdThreshold(roundMtd(pcbAdditional))

  return {
    normal: normalRounded,
    additional: arRounded,
    total: roundMtd(normalRounded + arRounded),
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
