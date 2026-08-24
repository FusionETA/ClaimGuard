import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

/**
 * GET /api/v1/leave/applications — who is off, who applied, what's
 * waiting on a decision.
 *
 * This closes the largest gap in the API: leave applications had no
 * endpoint at all, which made the three most-asked HR questions
 * unanswerable — who is off next week, what's pending my approval, did
 * Aisyah's request get approved.
 *
 * Date filtering matches applications that **overlap** the window, not
 * ones contained by it. "Who is off next week" has to include the leave
 * that started last Friday and runs through Tuesday; a containment
 * filter would silently drop exactly the person you were asking about.
 *
 * Query params:
 *   - status     (PENDING | APPROVED | REJECTED | CANCELLED)
 *   - employeeId (EmployeeProfile id — from `employeeProfileId` on the
 *                 employees resource, NOT the User id)
 *   - from / to  (ISO yyyy-mm-dd, inclusive, overlap semantics)
 *   - limit      (1..500, default 100)
 *
 * Scope: `leave:read`.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  employeeId: z.string().trim().min(1).optional(),
  from: z.string().trim().regex(ISO_DATE).optional(),
  to: z.string().trim().regex(ISO_DATE).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const GET = handleApiRequest(["leave:read"], async (request, ctx) => {
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

  const applications = await leaveRepository.listApplicationsForOrganization(
    ctx.integration.organizationId,
    {
      status: q.status,
      employeeId: q.employeeId,
      // `to` is inclusive: take the whole day by comparing against
      // end-of-day, so a one-day leave on the boundary is included.
      from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined,
      to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined,
      limit: q.limit,
    },
  )

  return NextResponse.json({
    data: applications,
    total: applications.length,
  })
})
