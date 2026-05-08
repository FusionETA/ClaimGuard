import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import {
  employeePayoutMethods,
  otPayoutMethods,
  resolveEmployeePayoutMethod,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Pagination defaults. The list endpoint always returns at most
 * `MAX_LIMIT` rows; the client can page via `?limit=&offset=`.
 */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * GET /api/v1/employees
 *
 * Required scope: `employees:read`.
 * Query params:
 *   - limit  (1..200, default 50)
 *   - offset (default 0)
 *   - role   (EMPLOYEE | SUPERVISOR — optional filter)
 */
export const GET = handleApiRequest(["employees:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const limit = clampInt(url.searchParams.get("limit"), 1, MAX_LIMIT, DEFAULT_LIMIT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0)
  const roleFilter = url.searchParams.get("role")

  const all = await organizationRepository.getOrganizationMembers(
    ctx.integration.organizationId,
  )

  const filtered = roleFilter
    ? all.filter((m) => m.role === roleFilter)
    : all
  const slice = filtered.slice(offset, offset + limit)

  return NextResponse.json({
    data: slice.map(toExternalEmployee),
    pagination: {
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
    },
  })
})

const projectAssignmentSchema = z.object({
  projectId: z.string().min(1),
  teamId: z.string().min(1),
  layer: z.number().int().min(1),
  chainApprovers: z
    .array(z.object({ layer: z.number().int().min(1), userId: z.string().min(1) }))
    .default([]),
})

const createEmployeeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters."),
  employeeId: z.string().trim().min(1, "Employee ID is required."),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  jobTitle: z.string().trim().min(1, "Job title is required."),
  payoutMethod: z.enum(employeePayoutMethods),
  otPayoutMethod: z.enum(otPayoutMethods).default("CASH"),
  hourlyRate: z.number().positive().optional(),
  xeroConnectionId: z.string().optional(),
  projectIds: z.array(z.string()).default([]),
  projectAssignments: z.array(projectAssignmentSchema).default([]),
})

/**
 * POST /api/v1/employees
 *
 * Required scope: `employees:write`.
 *
 * Mirrors the payload shape of the admin "Add hierarchy member" dialog
 * but flattened. Wrap-in-transaction is delegated to the repo
 * (`createOrganizationMember` already uses a Prisma transaction
 * internally).
 *
 * Body:
 *   {
 *     name, email, password, employeeId, role,
 *     jobTitle, payoutMethod, otPayoutMethod, hourlyRate?,
 *     xeroConnectionId?,
 *     projectIds: string[],
 *     projectAssignments: [
 *       { projectId, teamId, layer, chainApprovers: [{layer, userId}, ...] }
 *     ]
 *   }
 */
export const POST = handleApiRequest(["employees:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { status: 400, message: "Invalid JSON body." } },
      { status: 400 },
    )
  }

  const parsed = createEmployeeSchema.safeParse(body)
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

  // Normalize payout-method against role (SUPERVISOR is forced to
  // MONTHLY_BASED) — same rule as the admin form.
  const payoutMethod = resolveEmployeePayoutMethod(
    parsed.data.role,
    parsed.data.payoutMethod,
  )
  const otPayoutMethod =
    payoutMethod === "MONTHLY_BASED" && parsed.data.otPayoutMethod === "TIME_BANK"
      ? "TIME_BANK"
      : "CASH"

  try {
    await organizationRepository.createOrganizationMember({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      employeeId: parsed.data.employeeId,
      role: parsed.data.role,
      organizationId: ctx.integration.organizationId,
      projectIds: parsed.data.projectIds,
      jobTitle: parsed.data.jobTitle,
      payoutMethod,
      otPayoutMethod,
      hourlyRate: parsed.data.hourlyRate ?? null,
      xeroConnectionId: parsed.data.xeroConnectionId,
      projectAssignments: parsed.data.projectAssignments,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create employee."
    // Email collision / employeeId collision come back here; surface
    // verbatim so the partner can react.
    return NextResponse.json(
      { error: { status: 409, message } },
      { status: 409 },
    )
  }

  return NextResponse.json({ ok: true }, { status: 201 })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Project the internal `OrganizationMember` shape into the external API
 * contract. Don't leak internal-only fields (cache flags, internal ids
 * that aren't meaningful to integrators, etc).
 */
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
  xeroConnectionId?: string
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
    // EmployeeProfile id — partners need this for
    // POST /api/v1/teams/[id]/members.
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
