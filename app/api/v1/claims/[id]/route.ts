import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

import { toExternalClaim } from "../_shared"

/**
 * GET /api/v1/claims/[id]
 *
 * Required scope: `claims:read`. Reuses the org-scoped list query then
 * filters down — there's no per-id repo method that returns a fully
 * projected ClaimRecord today, and adding one for one route would
 * duplicate the heavy `getClaimsForOrganization` projection logic
 * (chain resolution, payViaAccount join, mileage snapshot, etc.).
 */

type RouteParams = { id: string }

export const GET = handleApiRequest<RouteParams>(
  ["claims:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) {
      return NextResponse.json(
        { error: { status: 400, message: "Missing claim id." } },
        { status: 400 },
      )
    }

    const all = await claimRepository.getClaimsForOrganization(
      ctx.integration.organizationId,
    )
    const claim = all.find((c) => c.id === id)
    if (!claim) {
      return NextResponse.json(
        { error: { status: 404, message: "Claim not found." } },
        { status: 404 },
      )
    }

    return NextResponse.json({ data: toExternalClaim(claim) })
  },
)
