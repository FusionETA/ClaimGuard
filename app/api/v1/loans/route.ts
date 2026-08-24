import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { employeeLoanRepository } from "@/modules/payroll/infrastructure/employee-loan.repository"

/**
 * GET /api/v1/loans — staff loans and their repayment schedules.
 *
 * Loans reduce net pay through an installment on each run, so "how much
 * does Ahmad still owe" is a payroll question, not an HR trivia one.
 * The `schedule` array is per-installment, ordered from the loan's
 * start period, so a caller can compute the outstanding balance without
 * a second call.
 *
 * Query params:
 *   - status (ACTIVE — omit for every loan on record)
 *
 * Scope: `payroll:read`.
 */
const querySchema = z.object({
  status: z.enum(["ACTIVE"]).optional(),
})

export const GET = handleApiRequest(["payroll:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  )
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          status: 400,
          message: "Validation failed.",
          details: parsed.error.flatten(),
        },
      },
      { status: 400 },
    )
  }

  const organizationId = ctx.integration.organizationId
  const loans =
    parsed.data.status === "ACTIVE"
      ? await employeeLoanRepository.listActiveForOrganization(organizationId)
      : await employeeLoanRepository.listForOrganization(organizationId)

  return NextResponse.json({ data: loans, total: loans.length })
})
