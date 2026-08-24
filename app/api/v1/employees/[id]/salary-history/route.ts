import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { salaryChangeRepository } from "@/modules/payroll/infrastructure/salary-change.repository"

type RouteParams = { id: string }

/**
 * GET /api/v1/employees/[id]/salary-history
 *
 * Every recorded salary change for one employee, newest first, with the
 * before and after snapshot, the reason, and who made it.
 *
 * `[id]` is the **User id** — the same identifier the rest of the
 * `/employees` resource uses — NOT the `employeeProfileId` the salary
 * repository keys on. We resolve between them here rather than exposing
 * a second identifier on the same resource: the three ids in this system
 * are easy to confuse, and passing the wrong one usually returns an
 * empty list rather than an error, which reads as "no raises" instead of
 * "wrong id". Keeping one id per resource removes that failure mode.
 *
 * A member that isn't in this org 404s — same rule as everywhere else,
 * so a foreign id is indistinguishable from a missing one.
 *
 * Scope: `payroll:read` — this is salary data, not headcount data.
 */
export const GET = handleApiRequest<RouteParams>(
  ["payroll:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) {
      return NextResponse.json(
        { error: { status: 400, message: "Missing employee id." } },
        { status: 400 },
      )
    }

    const members = await organizationRepository.getOrganizationMembers(
      ctx.integration.organizationId,
    )
    const member = members.find((m) => m.id === id)
    if (!member) {
      return NextResponse.json(
        { error: { status: 404, message: "Employee not found." } },
        { status: 404 },
      )
    }
    if (!member.employeeProfileId) {
      // A member with no payroll profile has no salary history rather
      // than a missing one — an empty list is the honest answer.
      return NextResponse.json({ data: [], total: 0 })
    }

    const changes = await salaryChangeRepository.listForEmployee(
      member.employeeProfileId,
    )
    return NextResponse.json({ data: changes, total: changes.length })
  },
)
