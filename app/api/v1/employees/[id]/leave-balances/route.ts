import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

type RouteParams = { id: string }

/**
 * GET /api/v1/employees/[id]/leave-balances?year=YYYY
 *
 * One employee's entitlement, accrued, used, carried and carry-expiry
 * per leave type for a year. Answers "how many days does she have
 * left" and "is anyone about to lose carried days".
 *
 * `[id]` is the **User id**, consistent with the rest of the
 * `/employees` resource; we resolve it to the EmployeeProfile id the
 * leave module keys on. Same reasoning as `salary-history` — one id per
 * resource, because the wrong id here returns an empty list rather than
 * an error.
 *
 * Per-employee rather than org-wide on purpose: the rich per-type view
 * (used / accrued / carried / expiry) only has a per-employee reader
 * today, and looping it across a whole org would be an N+1. An org-wide
 * balances grid wants a bulk repo method first — worth building, not
 * worth faking.
 *
 * `year` defaults to the current calendar year. Entitlement rows are
 * created lazily on first access, so a year nobody has touched comes
 * back empty rather than zero-filled — an empty list means "no rows
 * yet", not "no entitlement".
 *
 * Scope: `leave:read`.
 */
export const GET = handleApiRequest<RouteParams>(
  ["leave:read"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) {
      return NextResponse.json(
        { error: { status: 400, message: "Missing employee id." } },
        { status: 400 },
      )
    }

    const rawYear = new URL(request.url).searchParams.get("year")
    let year = new Date().getUTCFullYear()
    if (rawYear !== null) {
      const parsed = Number.parseInt(rawYear, 10)
      if (!Number.isFinite(parsed) || parsed < 2000 || parsed > 2100) {
        return NextResponse.json(
          {
            error: {
              status: 400,
              message: "`year` must be a 4-digit year between 2000 and 2100.",
            },
          },
          { status: 400 },
        )
      }
      year = parsed
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
      return NextResponse.json({ data: [], total: 0, year })
    }

    const balances = await leaveRepository.listEntitlementsForEmployee(
      member.employeeProfileId,
      year,
    )
    return NextResponse.json({ data: balances, total: balances.length, year })
  },
)
