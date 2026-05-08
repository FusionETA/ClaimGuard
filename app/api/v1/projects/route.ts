import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import type { OrganizationProjectOption } from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Projects collection. The `XeroProject` table is the canonical project
 * model — manually-created projects (`isManual: true`) are the ones a
 * partner manages through this API; Xero-imported projects are kept
 * read-only here so the partner doesn't accidentally fight the Xero
 * sync.
 *
 * Org isolation: every handler scopes by `ctx.integration.organizationId`.
 */

/**
 * GET /api/v1/projects
 *
 * Required scope: `projects:read`. Returns every active (non-disabled)
 * project for the org, manual or Xero-imported. Use `?isManual=true` to
 * narrow to only partner-created ones.
 */
export const GET = handleApiRequest(["projects:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const isManualFilter = url.searchParams.get("isManual")

  const projects = await organizationRepository.getProjectsForOrganization(
    ctx.integration.organizationId,
  )

  const filtered =
    isManualFilter === "true"
      ? projects.filter((p) => p.isManual)
      : isManualFilter === "false"
        ? projects.filter((p) => !p.isManual)
        : projects

  return NextResponse.json({
    data: filtered.map(toExternalProject),
    total: filtered.length,
  })
})

const createProjectSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  /// Project managers — must already exist as SUPERVISOR or ADMIN in the
  /// org. Empty / omitted = no PMs assigned (admin can add them later
  /// via PATCH or the dedicated managers endpoint).
  projectManagerIds: z.array(z.string().min(1)).optional(),
  location: z.string().trim().max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
})

/**
 * POST /api/v1/projects
 *
 * Required scope: `projects:write`. Always creates a manual project
 * (`isManual: true`). Xero-imported projects come from the sync and
 * shouldn't be partner-created.
 */
export const POST = handleApiRequest(["projects:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const parsed = createProjectSchema.safeParse(body)
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
    const created = await organizationRepository.createManualProject({
      organizationId: ctx.integration.organizationId,
      name: parsed.data.name,
      projectManagerIds: parsed.data.projectManagerIds ?? [],
      location: parsed.data.location,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
    })

    // `createManualProject` returns the create-shape projection; refetch
    // the full org list so we can return the same external shape every
    // other endpoint uses (with holidays, working hours, etc.).
    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const fresh = all.find((p) => p.id === created.id) ?? null

    return NextResponse.json(
      { data: fresh ? toExternalProject(fresh) : null },
      { status: 201 },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create project."
    return jsonError(409, message)
  }
})

// ---------------------------------------------------------------------------
// Helpers (also used by /api/v1/projects/[id]/route.ts — duplicated there
// to keep each route file self-contained per the existing pattern.)
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
    xeroConnectionId: p.xeroConnectionId ?? null,
    xeroProjectId: p.xeroProjectId ?? null,
  }
}
