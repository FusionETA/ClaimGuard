import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import {
  teamModules,
  type TeamDetail,
  type TeamSummary,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-team CRUD. Sibling to /api/v1/teams (list + create).
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/teams/[id]
 *
 * Required scope: `teams:read`. Returns the team WITH its members
 * (handy for the partner's UI to show "who's at each layer" without a
 * follow-up call to /employees).
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
    if (!team) {
      return jsonError(404, "Team not found.")
    }

    return NextResponse.json({ data: toExternalTeamDetail(team) })
  },
)

const teamModuleSchema = z.enum(teamModules)
const moduleConfigSchema = z.record(teamModuleSchema, z.array(z.number().int().min(1)))

const updateTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    layerCount: z.number().int().min(1).max(10).optional(),
    /// Pass `null` to clear custom labels (revert to "Layer 1, Layer 2,
    /// …" defaults). Pass a non-empty array to set them.
    layerLabels: z.array(z.string()).max(10).nullable().optional(),
    moduleConfig: moduleConfigSchema.optional(),
  })
  .strict()

/**
 * PATCH /api/v1/teams/[id]
 *
 * Required scope: `teams:write`. Pass any subset of fields. Shrinking
 * `layerCount` below an existing member's layer is rejected by the repo
 * with a "move them first" error — surfaced here as 409.
 */
export const PATCH = handleApiRequest<RouteParams>(
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

    const parsed = updateTeamSchema.safeParse(body)
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

    try {
      const updated = await organizationRepository.updateTeam({
        organizationId: ctx.integration.organizationId,
        teamId: id,
        name: parsed.data.name,
        layerCount: parsed.data.layerCount,
        layerLabels: parsed.data.layerLabels,
        moduleConfig: parsed.data.moduleConfig,
      })

      await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

      return NextResponse.json({ data: toExternalTeamSummary(updated) })
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not update team.")
      // "Team not found." → 404, everything else (validation /
      // shrink-with-members) → 409. Cheap string match because the repo
      // throws plain `Error("Team not found.")`.
      if (/not found/i.test(message)) {
        return jsonError(404, message)
      }
      return jsonError(409, message)
    }
  },
)

/**
 * DELETE /api/v1/teams/[id]
 *
 * Required scope: `teams:write`. Refuses if the team still has
 * members — partner must move/remove members first. That guard lives
 * in the repo's `deleteTeam`; we surface the error verbatim.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["teams:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing team id.")

    try {
      await organizationRepository.deleteTeam({
        organizationId: ctx.integration.organizationId,
        teamId: id,
      })
      await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })
      return NextResponse.json({ ok: true })
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not delete team.")
      if (/not found/i.test(message)) {
        return jsonError(404, message)
      }
      return jsonError(409, message)
    }
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalTeamSummary(t: TeamSummary) {
  return {
    id: t.id,
    name: t.name,
    projectId: t.projectId,
    projectName: t.projectName,
    layerCount: t.layerCount,
    layerLabels: t.layerLabels ?? null,
    moduleConfig: t.moduleConfig,
    memberCount: t.memberCount,
  }
}

function toExternalTeamDetail(t: TeamDetail) {
  return {
    ...toExternalTeamSummary(t),
    members: t.members.map((m) => ({
      membershipId: m.id,
      employeeProfileId: m.employeeProfileId,
      userId: m.userId,
      name: m.name,
      role: m.role,
      layer: m.layer,
    })),
  }
}
