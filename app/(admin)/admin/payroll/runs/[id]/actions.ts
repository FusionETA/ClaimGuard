"use server"

import { getPayrollPayslipDetailPageData } from "@/modules/payroll/application/services/payroll-run.service"
import type { PayslipData } from "@/modules/payroll/domain/runs"

/**
 * Lazy-load the full payslip data — including line items, EPF rates
 * snapshot, and statutory warnings — for the inline expandable row
 * on the run detail page. The list view (`PayslipRow`) deliberately
 * excludes line items for performance; this action fills in the gap
 * only when the admin clicks to expand a row.
 *
 * Returns null when the session/org doesn't match or the payslip
 * isn't on a run this admin can see.
 */
export async function fetchPayslipDetailForExpansionAction(input: {
  payslipId: string
}): Promise<PayslipData | null> {
  const result = await getPayrollPayslipDetailPageData({
    payslipId: input.payslipId,
  })
  if (!result) return null
  return result.payslip
}
