import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import {
  type ClaimStatus,
  type ClaimType,
} from "@/modules/claims/domain/models"

import { toExternalClaim } from "./_shared"

/**
 * Claims list. Companion to per-claim GET / review / sync endpoints.
 *
 * Today this endpoint is READ-ONLY — POST is intentionally NOT
 * implemented because creating a claim through the API needs:
 *   - file upload handling for the receipt (multipart/form-data, Xero
 *     Files relay, AI extraction)
 *   - mileage rate resolution + project working-hours validation
 *   - chart-of-account spend-limit pre-check
 *   - claim number generation
 *   - approval-chain resolution
 *
 * That's a separate scope's worth of code and warrants its own session.
 * Until then, claims must be created through the employee portal; the
 * API surface focuses on observation + admin actions (review).
 *
 * Org isolation: scoped by `ctx.integration.organizationId`.
 */

const PAGE_SIZE_DEFAULT = 50
const PAGE_SIZE_MAX = 200

/**
 * GET /api/v1/claims
 *
 * Required scope: `claims:read`. Filters:
 *   - ?status=PENDING|APPROVED|REVIEWED|REJECTED
 *   - ?type=EXPENSE|MILEAGE
 *   - ?employeeId=<employeeId>
 *   - ?awaitingSync=true (only REVIEWED + NOT_SYNCED)
 *   - ?limit=&offset= for paging
 */
export const GET = handleApiRequest(["claims:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const limit = clampInt(url.searchParams.get("limit"), 1, PAGE_SIZE_MAX, PAGE_SIZE_DEFAULT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0)
  const statusFilter = url.searchParams.get("status") as ClaimStatus | null
  const typeFilter = url.searchParams.get("type") as ClaimType | null
  const employeeFilter = url.searchParams.get("employeeId")?.trim()
  const awaitingSync = url.searchParams.get("awaitingSync") === "true"

  // Two source queries depending on whether the partner asked for the
  // sync queue specifically. `getClaimsAwaitingSync` is faster and
  // sorted differently (oldest reviewedAt first), so it's worth a
  // separate code path.
  const all = awaitingSync
    ? await claimRepository.getClaimsAwaitingSync(ctx.integration.organizationId)
    : await claimRepository.getClaimsForOrganization(ctx.integration.organizationId)

  const filtered = all.filter((claim) => {
    if (statusFilter && claim.status !== statusFilter) return false
    if (typeFilter && claim.claimType !== typeFilter) return false
    if (employeeFilter && claim.employee.employeeId !== employeeFilter) return false
    return true
  })

  const slice = filtered.slice(offset, offset + limit)

  return NextResponse.json({
    data: slice.map(toExternalClaim),
    pagination: {
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
    },
  })
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
 * Project the internal `ClaimRecord` shape into the external API
 * contract. Drop fields that aren't useful to a partner (cache flags,
 * UI-only derived values, raw approval chains — those go through their
 * own dedicated endpoint when partners need them).
 */
