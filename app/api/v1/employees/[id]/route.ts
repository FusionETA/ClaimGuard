import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import {
  employeePayoutMethods,
  otPayoutMethods,
  resolveEmployeePayoutMethod,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-employee CRUD endpoints. Companion to `/api/v1/employees`'s list +
 * create — these handle the "operate on a specific row" cases.
 *
 * Org isolation: every handler resolves `ctx.integration.organizationId`
 * and either filters by it (GET) or delegates to a repo method that
 * scopes to it (PATCH, DELETE). A token can never read or mutate
 * employees outside its bound org.
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/employees/[id]
 *
 * Required scope: `employees:read`. Returns 404 (not 403) when the
 * member exists but belongs to a different organization, so a partner
 * can't probe id space across tenants.
 */
export const GET = handleApiRequest<RouteParams>(
  ["employees:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) {
      return jsonError(400, "Missing employee id.")
    }

    // The list endpoint already does the same projection work; we just
    // pluck a single row from it. There's no per-id repo method today
    // and adding one for one route would duplicate the heavy
    // `getOrganizationMembers` projection logic.
    const all = await organizationRepository.getOrganizationMembers(
      ctx.integration.organizationId,
    )
    const member = all.find((m) => m.id === id)
    if (!member) {
      return jsonError(404, "Employee not found.")
    }

    return NextResponse.json({ data: toExternalEmployee(member) })
  },
)

/**
 * PATCH body shape — every field optional. Only the fields you include
 * are touched on the underlying row. Mirrors the admin "Edit member"
 * dialog so partners can map their UI to ours 1:1.
 */
const projectAssignmentSchema = z.object({
  projectId: z.string().min(1),
  teamId: z.string().min(1),
  layer: z.number().int().min(1),
  chainApprovers: z
    .array(z.object({ layer: z.number().int().min(1), userId: z.string().min(1) }))
    .default([]),
})

const updateEmployeeSchema = z
  .object({
    role: z.enum(["EMPLOYEE", "SUPERVISOR"]).optional(),
    jobTitle: z.string().trim().min(1).optional(),
    payoutMethod: z.enum(employeePayoutMethods).optional(),
    otPayoutMethod: z.enum(otPayoutMethods).optional(),
    hourlyRate: z.number().positive().nullable().optional(),
    /// Legacy direct project assignment list. Most partners should use
    /// `projectAssignments` (which carries team + chain) instead — but
    /// kept supported because the admin form still emits both shapes.
    projectIds: z.array(z.string()).optional(),
    projectAssignments: z.array(projectAssignmentSchema).optional(),
  })
  .strict()

/**
 * PATCH /api/v1/employees/[id]
 *
 * Required scope: `employees:write`. Pass any subset of fields. Omitted
 * fields stay untouched. Note: name + email + password are NOT mutable
 * here — those live on the `User` row and aren't part of the standard
 * employee-update flow today (the admin UI doesn't expose them either).
 * If a partner needs to rotate an admin's email, that's a future
 * `/api/v1/users/[id]` endpoint.
 */
export const PATCH = handleApiRequest<RouteParams>(
  ["employees:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing employee id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    // Defensive: a partner that accidentally POSTs a create-payload to
    // PATCH (or vice-versa) will otherwise get a confusing
    // "unrecognized key" Zod error. Surface a clearer message instead
    // — these fields are ONLY accepted on POST /api/v1/employees.
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>
      const createOnly = ["password", "name", "email", "employeeId"].filter(
        (k) => k in b,
      )
      if (createOnly.length > 0) {
        return jsonError(
          400,
          `Field${createOnly.length === 1 ? "" : "s"} ${createOnly.join(", ")} cannot be updated via PATCH. Use POST /api/v1/employees to create a new member, or omit ${createOnly.length === 1 ? "this field" : "these fields"} to update.`,
        )
      }
    }

    const parsed = updateEmployeeSchema.safeParse(body)
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

    // Scope-check before update: confirm the member belongs to this
    // org. `updateOrganizationMember` itself doesn't take a "must
    // exist in org" guard — it'll silently no-op if the userId isn't
    // in the org's User table (because of the role + projectIds
    // checks). Doing it here gives us a clean 404 instead of confused
    // 200/no-change.
    const all = await organizationRepository.getOrganizationMembers(
      ctx.integration.organizationId,
    )
    const existing = all.find((m) => m.id === id)
    if (!existing) {
      return jsonError(404, "Employee not found.")
    }

    const role = parsed.data.role ?? existing.role
    // Same coercion the admin form does: SUPERVISOR is forced to
    // MONTHLY_BASED; OT TIME_BANK only stays if MONTHLY_BASED.
    const payoutMethod = resolveEmployeePayoutMethod(
      role,
      parsed.data.payoutMethod ?? existing.payoutMethod,
    )
    const requestedOtMethod = parsed.data.otPayoutMethod ?? existing.otPayoutMethod
    const otPayoutMethod =
      payoutMethod === "MONTHLY_BASED" && requestedOtMethod === "TIME_BANK"
        ? "TIME_BANK"
        : "CASH"

    try {
      await organizationRepository.updateOrganizationMember({
        userId: id,
        role,
        organizationId: ctx.integration.organizationId,
        // `projectIds` is only updated when explicitly passed. The repo
        // requires the field, so we pass the existing list when omitted
        // to keep things untouched.
        projectIds:
          parsed.data.projectIds ??
          existing.projects.map((p) => p.id),
        jobTitle: parsed.data.jobTitle ?? existing.jobTitle,
        payoutMethod,
        otPayoutMethod,
        hourlyRate:
          parsed.data.hourlyRate === undefined
            ? existing.hourlyRate ?? null
            : parsed.data.hourlyRate,
        // Preserve whatever xeroConnectionId is on the row today — the
        // external API can't set or change it, but the field still
        // exists on the underlying repo input. Pass through unchanged.
        xeroConnectionId: existing.xeroConnectionId,
        projectAssignments: parsed.data.projectAssignments,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not update employee."
      return jsonError(409, message)
    }

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    // Return the freshly-projected row so the caller doesn't need a
    // follow-up GET.
    const refreshed = await organizationRepository.getOrganizationMembers(
      ctx.integration.organizationId,
    )
    const updated = refreshed.find((m) => m.id === id)
    return NextResponse.json({
      data: updated ? toExternalEmployee(updated) : null,
    })
  },
)

/**
 * DELETE /api/v1/employees/[id]
 *
 * Required scope: `employees:write`. Hard-deletes the User row, which
 * cascades through EmployeeProfile + project/team memberships + chain
 * rows. Refuses to delete an ADMIN through this endpoint — those have
 * their own management flow.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["employees:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing employee id.")

    const result = await organizationRepository.deleteOrganizationMember({
      userId: id,
      organizationId: ctx.integration.organizationId,
    })

    if (!result.ok) {
      // Either the user doesn't exist in this org OR they're an admin
      // (deleteOrganizationMember refuses both). 404 keeps the failure
      // mode opaque to id-probing.
      return jsonError(404, "Employee not found in this organization.")
    }

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

function toExternalEmployee(member: {
  id: string
  employeeProfileId?: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR"
  employeeId: string
  jobTitle: string
  payoutMethod: string
  otPayoutMethod: string
  hourlyRate?: number
  xeroConnectionId?: string  // present on input shape but not surfaced
  projects: Array<{ id: string; name: string }>
  teams: Array<{
    teamId: string
    teamName: string
    projectId: string
    projectName: string
    layer: number
  }>
}) {
  return {
    id: member.id,
    employeeProfileId: member.employeeProfileId ?? null,
    name: member.name,
    email: member.email,
    role: member.role,
    employeeId: member.employeeId,
    jobTitle: member.jobTitle,
    payoutMethod: member.payoutMethod,
    otPayoutMethod: member.otPayoutMethod,
    hourlyRate: member.hourlyRate ?? null,
    projects: member.projects,
    teams: member.teams.map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      projectId: t.projectId,
      projectName: t.projectName,
      layer: t.layer,
    })),
  }
}
