import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-member endpoints inside a team. Companion to /teams/[id]/members
 * (list + add). PATCH lets the partner change a member's layer or
 * chain without removing + re-adding; DELETE removes.
 */

type RouteParams = { id: string; membershipId: string }

const patchMemberSchema = z
  .object({
    layer: z.number().int().min(1).max(10).optional(),
    chain: z
      .array(z.object({ layer: z.number().int().min(1), userId: z.string().min(1) }))
      .optional(),
  })
  .strict()

/**
 * PATCH /api/v1/teams/[id]/members/[membershipId]
 *
 * Required scope: `teams:write`. Updates layer and/or chain for an
 * existing member. Pass either or both.
 */
export const PATCH = handleApiRequest<RouteParams>(
  ["teams:write"],
  async (request, ctx) => {
    const { id, membershipId } = ctx.params
    if (!id || !membershipId) {
      return jsonError(400, "Missing team id or membership id.")
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = patchMemberSchema.safeParse(body)
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

    if (parsed.data.layer === undefined && parsed.data.chain === undefined) {
      return jsonError(400, "Provide at least one of layer or chain.")
    }

    // Look up the team to find the member, scope-checking by org.
    const team = await organizationRepository.getTeam(
      id,
      ctx.integration.organizationId,
    )
    if (!team) return jsonError(404, "Team not found.")

    const member = team.members.find((m) => m.id === membershipId)
    if (!member) {
      return jsonError(404, "Membership not found.")
    }

    // Layer change: re-issue assignTeamMember with the new layer (it's
    // upsert — same membership row gets updated).
    if (parsed.data.layer !== undefined && parsed.data.layer !== member.layer) {
      try {
        await organizationRepository.assignTeamMember({
          organizationId: ctx.integration.organizationId,
          employeeProfileId: member.employeeProfileId,
          teamId: id,
          layer: parsed.data.layer,
        })
      } catch (error) {
        const message =
          safeErrorMessage(error, "Could not update layer.")
        return jsonError(409, message)
      }
    }

    // Chain change: setTeamMembershipChain replaces the per-(employee,
    // team) chain rows.
    if (parsed.data.chain !== undefined) {
      try {
        await organizationRepository.setTeamMembershipChain({
          organizationId: ctx.integration.organizationId,
          teamId: id,
          employeeId: member.userId,
          chainApprovers: parsed.data.chain,
        })
      } catch (error) {
        const message =
          safeErrorMessage(error, "Could not update chain.")
        return jsonError(409, message)
      }
    }

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    // Refetch the now-updated member + chain so the response reflects
    // post-write state.
    const refreshedTeam = await organizationRepository.getTeam(
      id,
      ctx.integration.organizationId,
    )
    const refreshedMember = refreshedTeam?.members.find((m) => m.id === membershipId)
    const chain = await organizationRepository.getTeamMembershipChain({
      organizationId: ctx.integration.organizationId,
      teamId: id,
      employeeId: member.userId,
    })

    return NextResponse.json({
      data: refreshedMember
        ? {
            membershipId: refreshedMember.id,
            employeeProfileId: refreshedMember.employeeProfileId,
            userId: refreshedMember.userId,
            name: refreshedMember.name,
            role: refreshedMember.role,
            layer: refreshedMember.layer,
            chain,
          }
        : null,
    })
  },
)

/**
 * DELETE /api/v1/teams/[id]/members/[membershipId]
 *
 * Required scope: `teams:write`. Removes the membership row and any
 * chain rows scoped to this (employee, team). Doesn't delete the
 * employee themselves — they remain in other teams + projects.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["teams:write"],
  async (_request, ctx) => {
    const { id, membershipId } = ctx.params
    if (!id || !membershipId) {
      return jsonError(400, "Missing team id or membership id.")
    }

    // Org-scope: the team must belong to this org. The repo's
    // removeTeamMember does a similar check internally but we do it up
    // front for a clean 404 on foreign team ids.
    const team = await organizationRepository.getTeam(
      id,
      ctx.integration.organizationId,
    )
    if (!team) return jsonError(404, "Team not found.")
    if (!team.members.some((m) => m.id === membershipId)) {
      return jsonError(404, "Membership not found in this team.")
    }

    try {
      await organizationRepository.removeTeamMember({
        organizationId: ctx.integration.organizationId,
        membershipId,
      })
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not remove member.")
      if (/not found/i.test(message)) {
        return jsonError(404, message)
      }
      return jsonError(409, message)
    }

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    return NextResponse.json({ ok: true })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
