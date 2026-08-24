import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { PAYROLL_ADJUSTMENT_CATEGORY_META } from "@/modules/payroll/domain/models"

/**
 * GET /api/v1/payroll/adjustment-categories — the dictionary of payroll
 * adjustment items and their statutory treatment.
 *
 * ## Why this is a resource and not documentation
 *
 * "Add a bonus of RM4,000" does not identify a payroll item. Annual
 * Bonus is EPF-subject but NOT SOCSO/EIS-subject; Non-Annual Bonus is
 * subject to all three. Same English word, different PERKESO
 * contributions on both the employer and employee side, flowing into
 * statutory filings. And a caller that omits the category entirely gets
 * `allowance_standard`, which books a bonus as a recurring allowance —
 * wrong contributions AND the wrong PCB method (projected across the
 * year rather than taxed as Additional Remuneration).
 *
 * So the choice cannot be inferred from a phrase. This endpoint exists
 * so a caller can put the real options, with their consequences, in
 * front of the person who knows which one they meant — and so it never
 * has to hardcode a list that drifts from ours.
 *
 * Projected straight from `PAYROLL_ADJUSTMENT_CATEGORY_META`, the same
 * constant the calc engine reads. There is no second copy to fall out
 * of date, which is the whole point.
 *
 * Static reference data — the response is identical for every org.
 *
 * Scope: `payroll:read`.
 */
export const GET = handleApiRequest(["payroll:read"], async (_request, ctx) => {
  void ctx
  const categories = Object.values(PAYROLL_ADJUSTMENT_CATEGORY_META)

  return NextResponse.json({
    data: categories,
    total: categories.length,
    /// Grouped index, so a caller can render a picker without
    /// re-deriving the grouping we already maintain.
    groups: Array.from(new Set(categories.map((c) => c.group))).map(
      (group) => ({
        group,
        codes: categories.filter((c) => c.group === group).map((c) => c.code),
      }),
    ),
  })
})
