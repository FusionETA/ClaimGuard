import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import {
  defaultModuleConfig,
  teamModules,
  type TeamModuleConfig,
  type TeamSummary,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Teams collection. Each XeroProject can host multiple Teams; a Team
 * defines a fixed number of approval-chain layers and which layers
 * approve which module (CLAIMS / OT / LEAVE / ATTENDANCE).
 *
 * Org isolation: every handler scopes via repo methods that filter on
 * `project: { organizationId }`. The token-bound org never leaks.
 */

/**
 * GET /api/v1/teams
 *
 * Required scope: `teams:read`. Optional `?projectId=` filter narrows
 * to a single project's teams.
 */
export const GET = handleApiRequest(["teams:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const projectIdFilter = url.searchParams.get("projectId")?.trim()

  const teams = await organizationRepository.listTeams(
    ctx.integration.organizationId,
  )
  const filtered = projectIdFilter
    ? teams.filter((t) => t.projectId === projectIdFilter)
    : teams

  return NextResponse.json({
    data: filtered.map(toExternalTeam),
    total: filtered.length,
  })
})

const teamModuleSchema = z.enum(teamModules)
const moduleConfigSchema = z.record(teamModuleSchema, z.array(z.number().int().min(1)))

const createTeamSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  layerCount: z.number().int().min(1).max(10),
  /// Per-module list of layers that must approve. Defaults to "every
  /// layer approves every module" via `defaultModuleConfig`.
  moduleConfig: moduleConfigSchema.optional(),
  /// Friendly labels per layer, e.g. ["IC","Manager","Director"].
  layerLabels: z.array(z.string()).max(10).optional(),
})

/**
 * POST /api/v1/teams
 *
 * Required scope: `teams:write`. The repo verifies the project belongs
 * to the same organization, so passing a foreign projectId surfaces as
 * "Project not found in this organization."
 */
export const POST = handleApiRequest(["teams:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const parsed = createTeamSchema.safeParse(body)
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

  // Fill in default moduleConfig if the partner didn't supply one. The
  // repo would also do this, but normalising here lets us return a
  // consistent moduleConfig shape in the response.
  const moduleConfig: TeamModuleConfig = (parsed.data.moduleConfig ??
    defaultModuleConfig(parsed.data.layerCount)) as TeamModuleConfig

  try {
    const created = await organizationRepository.createTeam({
      organizationId: ctx.integration.organizationId,
      projectId: parsed.data.projectId,
      name: parsed.data.name,
      layerCount: parsed.data.layerCount,
      moduleConfig,
      layerLabels: parsed.data.layerLabels ?? null,
    })

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    return NextResponse.json({ data: toExternalTeam(created) }, { status: 201 })
  } catch (error) {
    const message =
      safeErrorMessage(error, "Could not create team.")
    return jsonError(409, message)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalTeam(t: TeamSummary) {
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
