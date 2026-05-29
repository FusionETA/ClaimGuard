import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * GET /api/v1/employees/active-count
 *
 * Required scope: `employees:read`.
 *
 * Returns a single integer headcount of "active" employees in the
 * integration's organization.
 *
 *   Active = User with role EMPLOYEE or SUPERVISOR AND
 *            PayrollProfile.isArchived ≠ true
 *            (users without a PayrollProfile yet still count as active).
 *
 * The shape intentionally matches the pagination wrapper used by the
 * `/employees` list endpoint so consumers can treat both endpoints the
 * same way (`response.data.count` vs. `response.data.length`).
 *
 * Example:
 *   {
 *     "data": {
 *       "count": 47,
 *       "asOf": "2026-05-29T10:23:11.482Z"
 *     }
 *   }
 */
export const GET = handleApiRequest(
  ["employees:read"],
  async (_request, ctx) => {
    const count = await organizationRepository.countActiveEmployees(
      ctx.integration.organizationId,
    )
    return NextResponse.json({
      data: {
        count,
        asOf: new Date().toISOString(),
      },
    })
  },
)
