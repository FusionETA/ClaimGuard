import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

import { toExternalClaim } from "../../_shared"

/**
 * POST /api/v1/claims/[id]/sync
 *
 * Required scope: `claims:write`. Marks a REVIEWED claim as synced to
 * Xero. Today the underlying `syncClaim` is a stub that flips
 * `xeroSyncStatus` to SYNCED without making the real Xero call — the
 * full Xero create-bill flow is wired up in the admin UI's sync action
 * and TBD for the API surface.
 *
 * Optional body:
 *   {
 *     "chartOfAccountId": "..."   // last-chance recode before sync
 *   }
 */

type RouteParams = { id: string }

const syncSchema = z
  .object({
    chartOfAccountId: z.string().trim().min(1).optional(),
  })
  .strict()

export const POST = handleApiRequest<RouteParams>(
  ["claims:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing claim id.")

    // Body is optional — accept empty / no body.
    let parsedBody: { chartOfAccountId?: string } = {}
    if (request.headers.get("content-length") !== "0") {
      try {
        const body = (await request.json()) as unknown
        const parsed = syncSchema.safeParse(body ?? {})
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
        parsedBody = parsed.data
      } catch {
        // No body or malformed — treat as empty (still valid).
      }
    }

    // Org-scope the claim before syncClaim touches it (the underlying
    // repo doesn't know about organizationId).
    const allClaims = await claimRepository.getClaimsForOrganization(
      ctx.integration.organizationId,
    )
    const claim = allClaims.find((c) => c.id === id)
    if (!claim) {
      return jsonError(404, "Claim not found.")
    }

    const result = await claimRepository.syncClaim({
      claimId: id,
      chartOfAccountId: parsedBody.chartOfAccountId,
    })

    if (!result.ok) {
      const map: Record<string, { status: number; message: string }> = {
        DB_UNAVAILABLE: { status: 503, message: "Database is not configured." },
        NOT_FOUND: { status: 404, message: "Claim not found." },
        NOT_ACTIONABLE: {
          status: 409,
          message:
            "This claim isn't ready to sync — it must be REVIEWED and not yet synced.",
        },
      }
      const m = map[result.error] ?? { status: 500, message: "Sync failed." }
      return jsonError(m.status, m.message)
    }

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
