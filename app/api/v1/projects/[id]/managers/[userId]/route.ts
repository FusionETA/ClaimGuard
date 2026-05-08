import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * DELETE /api/v1/projects/[id]/managers/[userId]
 *
 * Required scope: `projects:write`. Granular PM removal — drops one
 * userId from the project's manager set. Implemented on top of the
 * repo's "replace the set" method (`updateProjectDetails`): we read
 * the current PMs, remove the target, write the rest back.
 *
 * 404 when:
 *   - the project doesn't exist in this org, OR
 *   - the user isn't currently a PM of that project
 *
 * Either way the partner can't tell from the error which case it is —
 * intentional, keeps id-probing useless.
 */

type RouteParams = { id: string; userId: string }

export const DELETE = handleApiRequest<RouteParams>(
  ["projects:write"],
  async (_request, ctx) => {
    const { id, userId } = ctx.params
    if (!id || !userId) {
      return jsonError(400, "Missing project id or user id.")
    }

    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const project = all.find((p) => p.id === id)
    if (!project) {
      return jsonError(404, "Project not found.")
    }

    const currentIds = project.projectManagers.map((pm) => pm.userId)
    if (!currentIds.includes(userId)) {
      return jsonError(404, "User is not a manager of this project.")
    }

    const remaining = currentIds.filter((u) => u !== userId)

    try {
      await organizationRepository.updateProjectDetails({
        projectId: id,
        organizationId: ctx.integration.organizationId,
        projectManagerIds: remaining,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not remove manager."
      return jsonError(409, message)
    }

    return NextResponse.json({ ok: true })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
