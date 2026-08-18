import { NextResponse } from "next/server"
import { z } from "zod"

import { isAdminRole } from "@/lib/auth/types"
import { getPrismaClient } from "@/lib/prisma"
import { getRedis, key } from "@/lib/redis"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

import { handleAuthEndpointRequest } from "../_shared"

/**
 * POST /api/v1/auth/verify-ticket
 *
 * Redeems a "Launch Appraisify" SSO ticket minted by GET /api/sso/appraisify.
 * Unlike POST /api/v1/auth/verify, this is not restricted to ADMIN/OWNER —
 * the ticket already proves the user was logged into AltomateHR when it was
 * minted, so every role can redeem one. Same dual-mode bearer auth (master
 * key or per-org token) and response shape as /api/v1/auth/verify, so one
 * token covers both endpoints.
 *
 * Responses:
 *   200 { data: { id, name, email, role, organizationId, organizationName, organizations } }
 *   400 invalid body
 *   401 invalid, expired, or already-used ticket
 *   403 ticket's organization doesn't match the calling per-org token
 */

const bodySchema = z.object({
  ticket: z.string().min(1, "Ticket is required."),
})

type StoredAppraisifyTicket = {
  userId: string
  organizationId: string | null
}

/** Mirrors the existing Altomate-Accounting redeemer's double-fire tolerance. */
const GRACE_TTL_SECONDS = 30

export const POST = handleAuthEndpointRequest(async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { status: 400, message: "Invalid JSON body." } },
      { status: 400 },
    )
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: { status: 400, message: "Validation failed.", details: parsed.error.flatten() } },
      { status: 400 },
    )
  }

  const redis = getRedis()
  if (!redis) {
    return NextResponse.json(
      { error: { status: 503, message: "SSO temporarily unavailable. The session store is not configured." } },
      { status: 503 },
    )
  }

  const ticketKey = key("sso", "appraisify", "ticket", parsed.data.ticket)
  const usedKey = key("sso", "appraisify", "used", parsed.data.ticket)

  let raw: string | null
  try {
    raw = await redis.getdel(ticketKey)
    if (raw) {
      await redis.set(usedKey, raw, "EX", GRACE_TTL_SECONDS)
    } else {
      raw = await redis.get(usedKey)
    }
  } catch {
    return NextResponse.json(
      { error: { status: 503, message: "SSO temporarily unavailable." } },
      { status: 503 },
    )
  }
  if (!raw) {
    return NextResponse.json(
      { error: { status: 401, message: "Invalid or expired ticket." } },
      { status: 401 },
    )
  }

  let claims: StoredAppraisifyTicket
  try {
    claims = JSON.parse(raw) as StoredAppraisifyTicket
  } catch {
    return NextResponse.json(
      { error: { status: 401, message: "Invalid or expired ticket." } },
      { status: 401 },
    )
  }
  if (typeof claims.userId !== "string" || claims.userId.length === 0) {
    return NextResponse.json(
      { error: { status: 401, message: "Invalid or expired ticket." } },
      { status: 401 },
    )
  }

  const prisma = getPrismaClient()
  if (!prisma) {
    return NextResponse.json(
      { error: { status: 503, message: "Database is not configured." } },
      { status: 503 },
    )
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    include: { organization: true },
  })
  if (!user) {
    return NextResponse.json(
      { error: { status: 401, message: "Invalid or expired ticket." } },
      { status: 401 },
    )
  }

  // Default to the user's primary org; fall back to it if the ticket's
  // target org no longer exists (mirrors buildSessionUserForEmail's
  // targetOrganizationId defensive fallback in lib/auth/authenticate.ts).
  let organizationId = user.organizationId ?? null
  let organizationName = user.organization?.name ?? null
  if (claims.organizationId && claims.organizationId !== organizationId) {
    const target = await prisma.organization.findUnique({
      where: { id: claims.organizationId },
      select: { id: true, name: true },
    })
    if (target) {
      organizationId = target.id
      organizationName = target.name
    }
  }

  // Org-mode tokens may only redeem tickets for their own organization.
  // Master-mode tokens have no such scoping (same trust boundary
  // /api/v1/auth/verify already extends to master keys).
  if (ctx.mode === "org" && organizationId !== ctx.organizationId) {
    return NextResponse.json(
      { error: { status: 403, message: "This ticket does not belong to the organization this token is scoped to." } },
      { status: 403 },
    )
  }

  const organizations = isAdminRole(user.role)
    ? await organizationRepository.getAdminOrganizations(user.id)
    : []

  return NextResponse.json({
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId,
      organizationName,
      organizations,
    },
  })
})
