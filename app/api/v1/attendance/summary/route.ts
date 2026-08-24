import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"

/**
 * GET /api/v1/attendance/summary?from=&to= — worked hours per employee
 * for a date range, bucketed the way payroll reads them.
 *
 * ## Summary, not records
 *
 * Deliberately NOT a punch-record feed. Raw attendance rows are high
 * volume and answer almost nothing on their own — "who has unapproved
 * OT this month" and "is anyone short of expected hours" are questions
 * about the aggregate. Returning thousands of rows would also spend the
 * context of an LLM caller on data it has to re-aggregate anyway, and
 * do it less reliably than we already do.
 *
 * Each employee carries the same `HoursBuckets` the attendance module
 * and payroll both consume, plus `expectedMin` so a caller can compute
 * the shortfall rather than guess at it. `otEnabled: false` means the
 * employee's policy has OT switched off and their minutes are folded
 * into normal — render those OT figures as not-applicable rather than
 * as zero, which reads as "worked no OT".
 *
 * Query params:
 *   - from / to   (ISO yyyy-mm-dd, required, inclusive)
 *   - employeeId  (single employee — User id, as the attendance module
 *                  keys employees by user)
 *   - projectId / teamId  (narrow to a site or team)
 *
 * Scope: `attendance:read`.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const querySchema = z
  .object({
    from: z.string().trim().regex(ISO_DATE, "from must be YYYY-MM-DD."),
    to: z.string().trim().regex(ISO_DATE, "to must be YYYY-MM-DD."),
    employeeId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
    teamId: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.from <= v.to, {
    message: "`from` must be on or before `to`.",
    path: ["from"],
  })

export const GET = handleApiRequest(["attendance:read"], async (request, ctx) => {
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
  const q = parsed.data

  const summary = await attendanceRepository.getHoursSummary({
    orgId: ctx.integration.organizationId,
    employeeId: q.employeeId,
    projectId: q.projectId,
    teamId: q.teamId,
    // The repo normalises these to start/end of day itself.
    from: new Date(`${q.from}T00:00:00.000Z`),
    to: new Date(`${q.to}T00:00:00.000Z`),
  })

  return NextResponse.json({
    data: summary.employees,
    totals: summary.totals,
    range: { from: q.from, to: q.to },
    total: summary.employees.length,
  })
})
