/**
 * Annual PCB-exemption ceilings for allowance line items that DON'T go
 * through the calc engine — i.e. rows written by the YTD import.
 *
 * Several categories are PCB-exempt only up to a yearly limit
 * (`taxExemptLimit` on the meta — e.g. official-duty travel RM 6,000 per
 * LHDN PR 5/2019 §7.2.1). The calc engine clamps these inline
 * (`calc.ts`, the `pcbTaxable` block) and persists the taxable slice on
 * `PayslipLineItem.pcbTaxableAmount`, which `getYtdForEmployee` reads via
 * COALESCE(pcbTaxableAmount, amount).
 *
 * The YTD import used to write `pcbTaxableAmount: null` on every row, so
 * that COALESCE fell back to the full amount and the ceiling was inert on
 * imported history: every exempt sen landed in Y, and the first computed
 * month after an import over-withheld for the rest of the year. This is
 * the same rule as the calc engine, extracted so the importer can apply it
 * month by month. Keep the two in step.
 */

export type TaxExemptMeta = {
  kind: string
  subjectToPcb: boolean
  taxExemptLimit?: number | null
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * The PCB-taxable slice of one allowance line, given how much of the
 * category's annual ceiling the employee has already used this year.
 *
 * Returns `pcbTaxableAmount: null` when nothing was clamped — the same
 * convention the calc engine persists, meaning "the whole amount is
 * taxable". `exempt` is what the caller adds to its running total for
 * the category.
 */
export function consumeTaxExemptHeadroom(input: {
  meta: TaxExemptMeta | null | undefined
  amount: number
  used: number
}): { pcbTaxableAmount: number | null; exempt: number } {
  const { meta, amount, used } = input
  if (
    !meta ||
    meta.kind !== "ALLOWANCE" ||
    !meta.subjectToPcb ||
    typeof meta.taxExemptLimit !== "number"
  ) {
    return { pcbTaxableAmount: null, exempt: 0 }
  }

  const remaining = Math.max(0, meta.taxExemptLimit - used)
  const exempt = Math.min(amount, remaining)
  const pcbTaxable = round2(Math.max(0, amount - exempt))

  return {
    pcbTaxableAmount: pcbTaxable < amount ? pcbTaxable : null,
    exempt,
  }
}
