import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { buildInitials } from "@/lib/utils"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import {
  type ClaimStatus,
  type ClaimType,
} from "@/modules/claims/domain/models"
import {
  createClaimForEmployee,
  type CreateClaimInput,
} from "@/modules/claims/application/services/claim-workflow.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import type { AuthenticatedSession } from "@/lib/auth/types"

import { toExternalClaim } from "./_shared"

/**
 * Claims collection.
 *
 * GET  — list claims for the bound org (read-only observation).
 * POST — create a claim on behalf of an employee (added so partner apps
 *        such as HRGenie can file claims via the API instead of only
 *        through the employee portal). It delegates to the SAME
 *        `createClaimForEmployee` service the web form uses, so mileage
 *        rate resolution, chart-of-account spend-limit checks, claim
 *        number generation, and approval-chain routing all behave
 *        identically — there is no parallel code path to keep in sync.
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

/**
 * POST /api/v1/claims
 *
 * Required scope: `claims:write`. Files a claim on behalf of an employee.
 *
 * Body (JSON):
 *   employeeId            string  — the human employee code, e.g. "A042"   (one of
 *   employeeUserId        string  — the internal user id (cuid)             these two)
 *   claimType             "EXPENSE" | "MILEAGE"   (defaults to EXPENSE)
 *   title                 string
 *   chartOfAccountId      string
 *   spentAt               string  — YYYY-MM-DD
 *   description           string
 *   paymentType           "PERSONAL" | "COMPANY"  (defaults PERSONAL)
 *   payViaAccountId       string  — required when paymentType === COMPANY
 *   projectId             string  — optional
 *   currency              string  — optional (defaults to org default)
 *   spendingWith          string  — optional
 *   receiptUrl            string  — optional (pre-uploaded receipt)
 *   amount                number  — EXPENSE only
 *   distance              number  — MILEAGE only
 *   mileageOriginAddress  string  — MILEAGE only
 *   mileageDestinationAddress string — MILEAGE only
 *
 * The endpoint resolves the target employee within the bound org, builds a
 * server-side session for them, and hands off to `createClaimForEmployee`.
 * It never trusts a client-supplied org/owner — the owner is always the
 * resolved employee, scoped to `ctx.integration.organizationId`.
 */
export const POST = handleApiRequest(["claims:write"], async (request, ctx) => {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const employeeCode = str(body.employeeId)
  const employeeUserId = str(body.employeeUserId)
  if (!employeeCode && !employeeUserId) {
    return jsonError(400, "Provide employeeId (code) or employeeUserId.")
  }

  // Resolve the target employee within the bound org. Returns 404 (not 403)
  // for unknown ids so a partner can't probe id space across tenants.
  const members = await organizationRepository.getOrganizationMembers(
    ctx.integration.organizationId,
  )
  const member = members.find(
    (m) =>
      (employeeUserId && m.id === employeeUserId) ||
      (employeeCode && m.employeeId === employeeCode),
  )
  if (!member) {
    return jsonError(404, "Employee not found in this organization.")
  }

  // Synthesize the session the workflow service expects. The owner of the
  // claim is always this resolved employee — never anything from the body.
  const session: AuthenticatedSession = {
    userId: member.id,
    email: member.email,
    name: member.name,
    role: member.role,
    initials: buildInitials(member.name),
    subtitle: member.jobTitle ?? "",
    organizationId: ctx.integration.organizationId,
    expiresAt: Date.now() + 60 * 60 * 1000,
  }

  const claimType: ClaimType = body.claimType === "MILEAGE" ? "MILEAGE" : "EXPENSE"

  const input: CreateClaimInput = {
    claimType,
    title: str(body.title),
    chartOfAccountId: str(body.chartOfAccountId),
    spentAt: str(body.spentAt),
    description: str(body.description),
    paymentType: body.paymentType === "COMPANY" ? "COMPANY" : "PERSONAL",
    payViaAccountId: str(body.payViaAccountId) || undefined,
    projectId: str(body.projectId) || undefined,
    spendingWith: str(body.spendingWith) || undefined,
    receiptUrl: str(body.receiptUrl) || undefined,
    ...(claimType === "MILEAGE"
      ? {
          distance: num(body.distance),
          mileageOriginAddress: str(body.mileageOriginAddress),
          mileageDestinationAddress: str(body.mileageDestinationAddress),
        }
      : {
          amount: num(body.amount),
        }),
  }

  const result = await createClaimForEmployee({ session, input })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, fieldErrors: result.fieldErrors ?? {} },
      { status: result.status },
    )
  }

  return NextResponse.json(
    {
      data: {
        ok: true,
        employee: { id: member.id, employeeId: member.employeeId, name: member.name },
        claimType,
      },
      warning: result.warning ?? null,
    },
    { status: 201 },
  )
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

/** Coerce an unknown JSON value to a trimmed string ("" when absent). */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v)
}

/** Coerce an unknown JSON value to a number (NaN when not parseable). The
 *  workflow service's Zod schema does the real validation/rejection. */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(str(v))
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/**
 * Project the internal `ClaimRecord` shape into the external API
 * contract. Drop fields that aren't useful to a partner (cache flags,
 * UI-only derived values, raw approval chains — those go through their
 * own dedicated endpoint when partners need them).
 */
