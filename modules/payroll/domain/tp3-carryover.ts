/**
 * Borang TP3 carryover — folding an employee's declared prior figures
 * into their year-to-date buckets before PCB is computed.
 *
 * Per LHDN MTD Spec §10 (page 23) a TP3 supplies (Y-K), X, Z and ∑LP from
 * employment earlier in the SAME calendar year, so a mid-year joiner is
 * withheld against their real annual income rather than being under-withheld
 * until December.
 *
 * This lives here, as one pure function, because it previously existed as two
 * copies — one in `generatePayrollPayslips`, one in
 * `previewEmployeeNetForRunInOrg` — and they drifted. The preview kept a
 * `joinedThisYear` precondition that generation had deliberately dropped, and
 * never gained the `prevIncludesPriorThisOrgPeriod` guard, so the net pay an
 * admin approved could differ from the net pay actually generated. Both call
 * sites now share this; keep it that way.
 */

/** The YTD buckets a TP3 contributes to. Extra keys are passed through. */
export type Tp3YtdBuckets = {
  ytdTaxable: number
  ytdEpf: number
  ytdPcb: number
  ytdZakat: number
  ytdAllowableDeductions: number
}

/** The `prev*` fields of a payroll profile. */
export type Tp3Declaration = {
  prevEmploymentYear?: number | null
  prevRemuneration?: number | null
  prevEpf?: number | null
  prevPcb?: number | null
  prevZakat?: number | null
  prevAllowableDeductions?: number | null
  prevIncludesPriorThisOrgPeriod?: boolean | null
}

/**
 * One bucket's carryover.
 *
 * `subtractThisOrg` is the rehire case: the admin entered the declaration as
 * the TOTAL year to date, which already includes the months worked at THIS
 * employer this year. Adding this org's own submitted payslips on top would
 * count those months twice, so they come off first. Clamped at zero — a
 * declaration smaller than what this org has already paid means the
 * declaration is stale, not that the employee earned negative income.
 */
function carry(
  declared: number | null | undefined,
  ownOrgYtd: number,
  subtractThisOrg: boolean,
): number {
  const amount = declared ?? 0
  if (amount <= 0) return 0

  return subtractThisOrg ? Math.max(0, amount - ownOrgYtd) : amount
}

/**
 * Fold a TP3 declaration into this org's own year-to-date figures.
 *
 * Returns `ownOrgYtd` unchanged unless the declaration is tagged with
 * `periodYear`. A TP3 declares ONE calendar year, so an untagged declaration
 * — or one tagged for a different year — is not attributable to this run and
 * contributes nothing. Without that gate a figure declared for 2026 would go
 * on inflating Y in 2027 and every year after, because nothing ever clears
 * the field.
 *
 * SOCSO + EIS is deliberately NOT carried: the RM 350 relief saturates within
 * the first few months at typical contribution levels, so a mid-year joiner
 * converges to the same answer either way.
 */
export function foldTp3Carryover<T extends Tp3YtdBuckets>(
  ownOrgYtd: T,
  profile: Tp3Declaration,
  periodYear: number,
): T {
  if ((profile.prevEmploymentYear ?? null) !== periodYear) return ownOrgYtd

  const subtract = profile.prevIncludesPriorThisOrgPeriod === true

  return {
    ...ownOrgYtd,
    ytdTaxable:
      ownOrgYtd.ytdTaxable +
      carry(profile.prevRemuneration, ownOrgYtd.ytdTaxable, subtract),
    ytdEpf: ownOrgYtd.ytdEpf + carry(profile.prevEpf, ownOrgYtd.ytdEpf, subtract),
    ytdPcb: ownOrgYtd.ytdPcb + carry(profile.prevPcb, ownOrgYtd.ytdPcb, subtract),
    ytdZakat:
      ownOrgYtd.ytdZakat + carry(profile.prevZakat, ownOrgYtd.ytdZakat, subtract),
    ytdAllowableDeductions:
      ownOrgYtd.ytdAllowableDeductions +
      carry(
        profile.prevAllowableDeductions,
        ownOrgYtd.ytdAllowableDeductions,
        subtract,
      ),
  }
}
