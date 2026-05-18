import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import {
  employeePayoutMethods,
  otPayoutMethods,
} from "@/modules/organization/domain/models"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

import { toExternalPolicy } from "../route"

/**
 * Per-policy CRUD. DELETE here is a **soft archive** — the underlying
 * `policyRepository.archive` flips `archivedAt` to now() and refuses
 * the call if any employee still references the policy OR if the
 * policy is the org's default. Same behaviour as the admin UI.
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/policies/[id]
 *
 * Required scope: `policies:read`. 404 when the id doesn't belong to
 * the caller's organisation — same as if it doesn't exist at all
 * (don't leak existence of other tenants' policies).
 */
export const GET = handleApiRequest<RouteParams>(
  ["policies:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing policy id.")

    const policy = await policyRepository.findById(
      id,
      ctx.integration.organizationId,
    )
    if (!policy) return jsonError(404, "Policy not found.")

    return NextResponse.json({ data: toExternalPolicy(policy) })
  },
)

/**
 * PATCH body shape — every field is optional, `description` accepts
 * null to clear it (other nullable fields use the same convention).
 * `.strict()` so unknown keys are rejected up-front rather than
 * silently ignored.
 */
const updatePolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),

    canAccessAttendance: z.boolean().optional(),
    canAccessClaims: z.boolean().optional(),
    canAccessLeave: z.boolean().optional(),

    salaryType: z.enum(employeePayoutMethods).optional(),
    otEnabled: z.boolean().optional(),
    otMethod: z.enum(otPayoutMethods).optional(),

    requireGeofence: z.boolean().optional(),
    requireSelfie: z.boolean().optional(),

    otRateNormalDay: z.number().nonnegative().optional(),
    otRateRestDay: z.number().nonnegative().optional(),
    otRatePublicHoliday: z.number().nonnegative().optional(),
    otRateRestDayInShift: z.number().nonnegative().optional(),
    otRatePublicHolidayInShift: z.number().nonnegative().optional(),
    otSalaryThreshold: z.number().nonnegative().nullable().optional(),
    otDailyThresholdMinutes: z.number().int().nonnegative().optional(),
  })
  .strict()

/**
 * PATCH /api/v1/policies/[id]
 *
 * Required scope: `policies:write`. Partial update — any omitted field
 * is left untouched. To make a policy the default, use
 * `POST /api/v1/policies/[id]/set-default` instead (the operation has
 * different semantics — atomically demotes the previous default —
 * and is intentionally not folded into PATCH).
 */
export const PATCH = handleApiRequest<RouteParams>(
  ["policies:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing policy id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = updatePolicySchema.safeParse(body)
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

    // Existence check up front so we return 404 instead of a confusing
    // "Policy not found" thrown from inside the repo's transaction.
    const existing = await policyRepository.findById(
      id,
      ctx.integration.organizationId,
    )
    if (!existing) return jsonError(404, "Policy not found.")

    try {
      const updated = await policyRepository.update({
        id,
        organizationId: ctx.integration.organizationId,
        ...parsed.data,
      })
      await bustOrgConfigCaches({
        organizationId: ctx.integration.organizationId,
      })
      return NextResponse.json({ data: toExternalPolicy(updated) })
    } catch (error) {
      const message = safeErrorMessage(error, "Could not update policy.")
      return jsonError(409, message)
    }
  },
)

/**
 * DELETE /api/v1/policies/[id]
 *
 * Required scope: `policies:write`. Soft-archives the policy. The repo
 * refuses to archive when:
 *   - any employee still references this policy (must be reassigned
 *     first), or
 *   - the policy is the org's current default (set another default
 *     first via `/set-default`).
 * Both refusals surface as 409 with a user-friendly message.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["policies:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing policy id.")

    const existing = await policyRepository.findById(
      id,
      ctx.integration.organizationId,
    )
    if (!existing) return jsonError(404, "Policy not found.")
    if (existing.archived) {
      return NextResponse.json({ ok: true, alreadyArchived: true })
    }

    try {
      await policyRepository.archive(id, ctx.integration.organizationId)
      await bustOrgConfigCaches({
        organizationId: ctx.integration.organizationId,
      })
      return NextResponse.json({ ok: true })
    } catch (error) {
      const message = safeErrorMessage(error, "Could not archive policy.")
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
