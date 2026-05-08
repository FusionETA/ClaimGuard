import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Team members sub-resource. Companion to /api/v1/teams/[id] — the
 * latter returns the full team incl. members; this endpoint is for
 * mutations so partners don't have to round-trip the whole team
 * payload to add or remove a single member.
 *
 * The chain is part of the member resource — passing `chain: [...]` on
 * POST sets the per-(employee, team) approval chain at the same time
 * as assigning the member to a layer. Without that, you'd need a
 * second call to set the chain, and the chain only makes sense once
 * the membership exists, so co-locating them keeps the API ergonomic.
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/teams/[id]/members
 *
 * Required scope: `teams:read`. Returns each member with their layer +
 * chain so the partner can render an org-chart-style view of the team
 * without separate per-member requests.
 */
export const GET = handleApiRequest<RouteParams>(
  ["teams:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing team id.")

    const team = await organizationRepository.getTeam(
      id,
      ctx.integration.organizationId,
    )
    if (!team) return jsonError(404, "Team not found.")

    // Fetch each member's chain in parallel — N small queries (one
    // per member). Fine at typical team sizes (10–50 members); if a
    // team grows large enough that this matters, add a batched
    // `getTeamMembershipsWithChains` repo method.
    const withChains = await Promise.all(
      team.members.map(async (m) => ({
        membershipId: m.id,
        employeeProfileId: m.employeeProfileId,
        userId: m.userId,
        name: m.name,
        role: m.role,
        layer: m.layer,
        chain: await organizationRepository.getTeamMembershipChain({
          organizationId: ctx.integration.organizationId,
          teamId: id,
          employeeId: m.userId,
        }),
      })),
    )

    return NextResponse.json({ data: withChains, total: withChains.length })
  },
)

const addMemberSchema = z.object({
  /// EmployeeProfile id (NOT User id). The repo's `assignTeamMember`
  /// keys on the profile so we require it directly to keep the route
  /// thin. Partners can fetch profile ids from a future
  /// `GET /api/v1/employees/[id]` extension that surfaces them — for
  /// now, profile ids are visible via the admin UI and
  /// `EmployeeProfile.employeeId` is NOT the same as
  /// `EmployeeProfile.id` (the former is the human-readable code).
  employeeProfileId: z.string().min(1),
  layer: z.number().int().min(1).max(10),
  /// Optional per-(employee, team) approval chain. Empty / omitted =
  /// no chain (claims auto-advance through the chain that's defined
  /// at the team level by other members). Provide to override.
  chain: z
    .array(z.object({ layer: z.number().int().min(1), userId: z.string().min(1) }))
    .optional(),
})

/**
 * POST /api/v1/teams/[id]/members
 *
 * Required scope: `teams:write`. Upsert semantics — if the
 * (employee, team) pair already exists, the layer is updated;
 * otherwise a new membership is created. Pass `chain: [...]` to set
 * the per-employee chain in the same call.
 *
 * Body MUST include `employeeProfileId`. The user id alone isn't
 * enough — `assignTeamMember` keys on the profile, and we don't have
 * a userId→profileId resolver helper today.
 */
export const POST = handleApiRequest<RouteParams>(
  ["teams:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing team id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = addMemberSchema.safeParse(body)
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

    let assignment
    try {
      assignment = await organizationRepository.assignTeamMember({
        organizationId: ctx.integration.organizationId,
        employeeProfileId: parsed.data.employeeProfileId,
        teamId: id,
        layer: parsed.data.layer,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not assign member."
      // Distinguish "team / employee not in this org" (404) from
      // validation failures (409). Cheap message-substring match.
      if (/not found/i.test(message)) {
        return jsonError(404, message)
      }
      return jsonError(409, message)
    }

    if (parsed.data.chain) {
      try {
        await organizationRepository.setTeamMembershipChain({
          organizationId: ctx.integration.organizationId,
          teamId: id,
          employeeId: assignment.userId,
          chainApprovers: parsed.data.chain,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not set chain."
        // The membership already committed; surface chain failure as
        // 409 so partner can retry the chain alone via PATCH (TBD)
        // without re-creating the membership.
        return jsonError(409, message)
      }
    }

    const chain = await organizationRepository.getTeamMembershipChain({
      organizationId: ctx.integration.organizationId,
      teamId: id,
      employeeId: assignment.userId,
    })

    return NextResponse.json(
      {
        data: {
          membershipId: assignment.id,
          employeeProfileId: assignment.employeeProfileId,
          userId: assignment.userId,
          name: assignment.name,
          role: assignment.role,
          layer: assignment.layer,
          chain,
        },
      },
      { status: 201 },
    )
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
