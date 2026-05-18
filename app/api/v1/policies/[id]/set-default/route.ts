import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

import { toExternalPolicy } from "../../route"

/**
 * POST /api/v1/policies/[id]/set-default
 *
 * Required scope: `policies:write`. Promotes this policy to the
 * organisation's default. Atomically demotes whichever policy was the
 * previous default inside the same DB transaction (so the "exactly
 * one default per org" invariant is never violated, even for a brief
 * window).
 *
 * This is split off from PATCH because it's a distinct intent — it's
 * the only field the partner can't toggle with a generic update — and
 * because the repo method has its own logic (multi-row update +
 * existence-+-archived check).
 *
 * Returns the updated policy projection, same shape as GET, so the
 * partner can confirm the flip without a follow-up read.
 */

type RouteParams = { id: string }

export const POST = handleApiRequest<RouteParams>(
  ["policies:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing policy id.")

    // Pre-flight: the repo throws "Active policy not found" for either
    // a missing id OR an archived policy. Splitting the checks here
    // lets us return a more specific 404 / 409 to the caller.
    const existing = await policyRepository.findById(
      id,
      ctx.integration.organizationId,
    )
    if (!existing) return jsonError(404, "Policy not found.")
    if (existing.archived) {
      return jsonError(
        409,
        "Cannot set an archived policy as default. Restore it first.",
      )
    }

    try {
      await policyRepository.setDefault(id, ctx.integration.organizationId)
    } catch (error) {
      const message = safeErrorMessage(
        error,
        "Could not set this policy as default.",
      )
      return jsonError(409, message)
    }

    await bustOrgConfigCaches({
      organizationId: ctx.integration.organizationId,
    })

    // Refetch + project so the response reflects the post-write state.
    const updated = await policyRepository.findById(
      id,
      ctx.integration.organizationId,
    )
    return NextResponse.json({
      data: updated ? toExternalPolicy(updated) : null,
    })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
