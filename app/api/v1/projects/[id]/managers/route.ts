import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Project managers sub-resource. Wraps `updateProjectDetails` so the
 * partner can manage PM assignments without having to reissue the full
 * project details payload.
 *
 * The repo is "replace-the-set" oriented (passing a `projectManagerIds`
 * array overwrites the entire PM set), so:
 *   - GET → list current
 *   - PUT → replace the set
 *   - DELETE one PM → use /managers/[userId]/route.ts (sibling)
 *
 * No POST add-one — partner can either:
 *   (a) PUT with the full new list, or
 *   (b) GET → append → PUT, which is one extra call but keeps the API
 *       surface small.
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/projects/[id]/managers
 *
 * Required scope: `projects:read`.
 */
export const GET = handleApiRequest<RouteParams>(
  ["projects:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const project = all.find((p) => p.id === id)
    if (!project) return jsonError(404, "Project not found.")

    return NextResponse.json({
      data: project.projectManagers,
      total: project.projectManagers.length,
    })
  },
)

const replaceManagersSchema = z.object({
  /// Replaces the project's manager set. Empty array clears all PMs.
  /// Each id must be a SUPERVISOR or ADMIN in the same org — repo
  /// enforces this and surfaces friendly error messages.
  userIds: z.array(z.string().min(1)).max(50),
})

/**
 * PUT /api/v1/projects/[id]/managers
 *
 * Required scope: `projects:write`. Replaces the entire PM set with
 * whatever's passed. Use an empty array to clear.
 */
export const PUT = handleApiRequest<RouteParams>(
  ["projects:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = replaceManagersSchema.safeParse(body)
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

    // Existence check first → cleaner 404 than letting the repo silently
    // no-op on a foreign id.
    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    if (!all.some((p) => p.id === id)) {
      return jsonError(404, "Project not found.")
    }

    try {
      await organizationRepository.updateProjectDetails({
        projectId: id,
        organizationId: ctx.integration.organizationId,
        projectManagerIds: parsed.data.userIds,
      })
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not update managers.")
      return jsonError(409, message)
    }

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    const refreshed = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const updated = refreshed.find((p) => p.id === id)
    return NextResponse.json({
      data: updated?.projectManagers ?? [],
      total: updated?.projectManagers.length ?? 0,
    })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
