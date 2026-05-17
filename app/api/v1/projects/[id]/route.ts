import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import type { OrganizationProjectOption } from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-project CRUD. Sibling to /api/v1/projects (list + create).
 *
 * DELETE only succeeds for manual (partner-created) projects —
 * Xero-imported projects come from the sync and aren't safe to delete
 * through the API. The `deleteManualProject` repo method enforces that
 * with a `where: { isManual: true }` clause.
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/projects/[id]
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
    if (!project) {
      return jsonError(404, "Project not found.")
    }

    return NextResponse.json({ data: toExternalProject(project) })
  },
)

const updateProjectSchema = z
  .object({
    /// Replace the project's manager set when provided (even as `[]`).
    /// Omitted = leave the existing managers untouched.
    projectManagerIds: z.array(z.string().min(1)).optional(),
    location: z.string().trim().max(200).optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
  })
  .strict()

/**
 * PATCH /api/v1/projects/[id]
 *
 * Required scope: `projects:write`. Today this only updates managers +
 * location/coordinates — name + working hours + holidays live behind
 * separate dedicated flows in the admin UI and aren't part of the
 * standard "edit project" payload yet. They can be added as separate
 * sub-endpoints later if a partner asks.
 */
export const PATCH = handleApiRequest<RouteParams>(
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

    const parsed = updateProjectSchema.safeParse(body)
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

    // Existence check first so we can give a clean 404 instead of letting
    // updateProjectDetails silently no-op on a foreign id.
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
        projectManagerIds: parsed.data.projectManagerIds,
        location: parsed.data.location,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
      })
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not update project.")
      return jsonError(409, message)
    }

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    const refreshed = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const updated = refreshed.find((p) => p.id === id)
    return NextResponse.json({
      data: updated ? toExternalProject(updated) : null,
    })
  },
)

/**
 * DELETE /api/v1/projects/[id]
 *
 * Required scope: `projects:write`. Hard-deletes a MANUAL project.
 * Xero-imported projects refuse to delete (the underlying repo's
 * `where: { isManual: true }` clause silently no-ops), and we surface
 * that as 404. Same goes for foreign-org ids.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["projects:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

    // Confirm first that the project (a) exists in our org, (b) is
    // manual. Anything else gets the same 404 — partner shouldn't be
    // able to distinguish "wrong org" from "Xero-imported".
    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const project = all.find((p) => p.id === id)
    if (!project) {
      return jsonError(404, "Project not found in this organization.")
    }
    if (!project.isManual) {
      return jsonError(
        409,
        "Xero-imported projects can't be deleted via the API. Manage them from your Xero workspace.",
      )
    }

    await organizationRepository.deleteManualProject({
      projectId: id,
      organizationId: ctx.integration.organizationId,
    })

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    return NextResponse.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalProject(p: OrganizationProjectOption) {
  return {
    id: p.id,
    name: p.name,
    status: p.status ?? null,
    isManual: p.isManual,
    location: p.location ?? null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    workingHoursStart: p.workingHoursStart ?? null,
    workingHoursEnd: p.workingHoursEnd ?? null,
    workingDays: p.workingDays ?? null,
    projectManagers: p.projectManagers,
    holidays: p.holidays ?? [],
  }
}
