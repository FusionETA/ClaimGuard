import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustClaimCaches } from "@/lib/cache-invalidation"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

import { toExternalClaim } from "../../_shared"

/**
 * POST /api/v1/claims/[id]/review
 *
 * Required scope: `approvals:write`. Approve or reject a claim that's
 * sitting in the admin's final-review queue (or supervisor-step queue
 * — `reviewClaim` figures out which step is current and advances or
 * terminates the chain).
 *
 * Reviewer identity: the API token isn't a user, so we can't attribute
 * the decision to "the partner". Instead we attribute it to the org's
 * first-created admin user (treated as the "system reviewer" from the
 * partner's perspective). If the org has no admin user yet, we refuse
 * with 409 — the partner needs to create one (via AltomateHR's
 * multi-admin UI) before claims can be reviewed via API.
 *
 * Body:
 *   {
 *     "decision": "APPROVED" | "REJECTED",
 *     "reviewNotes": "Optional notes (required when rejecting)"
 *   }
 */

type RouteParams = { id: string }

const reviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reviewNotes: z.string().trim().max(1000).optional(),
})

export const POST = handleApiRequest<RouteParams>(
  ["approvals:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing claim id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = reviewSchema.safeParse(body)
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

    if (parsed.data.decision === "REJECTED" && !parsed.data.reviewNotes) {
      return jsonError(400, "Rejection requires reviewNotes.")
    }

    // Org-scope the claim before letting reviewClaim touch it.
    const allClaims = await claimRepository.getClaimsForOrganization(
      ctx.integration.organizationId,
    )
    const claim = allClaims.find((c) => c.id === id)
    if (!claim) {
      return jsonError(404, "Claim not found.")
    }

    // Resolve a reviewer userId. Falls back to the org's first admin —
    // there's no per-token user identity in the external API, so the
    // first admin acts as the "system" attribution.
    const reviewerId = await claimRepository.getFirstAdminId(
      ctx.integration.organizationId,
    )
    if (!reviewerId) {
      return jsonError(
        409,
        "No admin user exists in this organization yet. Create one before reviewing claims via the API.",
      )
    }

    const result = await claimRepository.reviewClaim({
      claimId: id,
      status: parsed.data.decision,
      reviewNotes: parsed.data.reviewNotes,
      reviewerId,
      // `supervisorOnly: false` lets reviewClaim treat this as an admin
      // final-step decision when the chain has cleared. Repo handles
      // chain progression internally.
      supervisorOnly: false,
    })

    if (!result.ok) {
      const map: Record<string, { status: number; message: string }> = {
        DB_UNAVAILABLE: { status: 503, message: "Database is not configured." },
        NOT_FOUND: { status: 404, message: "Claim not found." },
        NOT_ACTIONABLE: {
          status: 409,
          message: "Claim is not in a state that can be reviewed.",
        },
        NOT_AUTHORIZED: {
          status: 403,
          message: "Reviewer is not authorized for this step.",
        },
      }
      const m = map[result.error] ?? {
        status: 500,
        message: "Review failed.",
      }
      return jsonError(m.status, m.message)
    }

    // Bust Redis claim caches for this org so the next admin or
    // employee read sees the post-review state.
    await bustClaimCaches({ organizationId: ctx.integration.organizationId })

    // Refetch + project the post-review claim so the partner doesn't
    // need a separate GET to see the new status.
    const refreshed = await claimRepository.getClaimsForOrganization(
      ctx.integration.organizationId,
    )
    const updated = refreshed.find((c) => c.id === id)
    return NextResponse.json({
      data: updated ? toExternalClaim(updated) : null,
    })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
