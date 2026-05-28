import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { getRedis, key } from "@/lib/redis"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/admin/sso-ticket
 *
 * Server-to-server SSO ticket minter. Altomate Accounting calls this to
 * obtain a short-lived SSO ticket for one of its provisioned
 * owners/admins, then redirects the customer's browser to:
 *
 *   <AltomateHR>{redirectPath}
 *
 * Authentication: per-organization API token (`Authorization: Bearer
 * wp_live_*`). The token's `organizationId` is the org we'll land the
 * user in. The master key is only for org creation (POST
 * /api/v1/admin/organizations).
 *
 * Internally the ticket is a short opaque ID (~22 chars). The actual
 * claims (email + organizationId) live in Redis under
 * `key("sso","ticket",<id>)` with a 120s TTL. The callback
 * /api/sso/altomate does GETDEL on that key — atomic single-use:
 * first click wins, subsequent clicks see an expired ticket.
 *
 * Why opaque + Redis instead of a self-contained JWT in the URL? The
 * JWT version meant a ~300-char `?token=eyJ…` query string. We already
 * used Redis for jti-replay protection, so we were never stateless.
 * Switching to a server-stored ticket buys a much shorter URL with the
 * same single-use semantics.
 */

const ticketSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .toLowerCase(),
})

const TICKET_TTL_SECONDS = 120

/** Stored ticket payload — kept tiny (Redis tax is per-byte). */
type StoredTicket = {
  email: string
  organizationId: string
}

export const POST = handleApiRequest([], async (request, { integration }) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { status: 400, message: "Invalid JSON body." } },
      { status: 400 },
    )
  }

  const parsed = ticketSchema.safeParse(body)
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

  const user = await organizationRepository.findUserByEmail(parsed.data.email)
  if (!user || (user.role !== "ADMIN" && user.role !== "OWNER")) {
    return NextResponse.json(
      {
        error: {
          status: 404,
          message:
            "No admin/owner with that email. Provision the owner via POST /api/v1/admin/organizations first.",
        },
      },
      { status: 404 },
    )
  }

  // Email must have admin access to THE specific org this token belongs
  // to. Same email can own multiple orgs — the per-org token is the
  // differentiator. Returns true when either an AdminOrganization row
  // exists OR the user is the legacy single-org admin
  // (User.organizationId === integration.organizationId).
  const hasAccess = await organizationRepository.isAdminOfOrganization(
    user.id,
    integration.organizationId,
  )
  if (!hasAccess) {
    return NextResponse.json(
      {
        error: {
          status: 404,
          message:
            "That email is not an admin/owner of the organization this API token belongs to.",
        },
      },
      { status: 404 },
    )
  }

  const redis = getRedis()
  if (!redis) {
    // Without Redis we can't store the ticket. Fail loudly so the
    // partner sees the misconfig instead of silently degrading.
    return NextResponse.json(
      {
        error: {
          status: 503,
          message:
            "SSO temporarily unavailable. The session store is not configured.",
        },
      },
      { status: 503 },
    )
  }

  // 16 random bytes -> 22 url-safe chars. Vast entropy; collision odds
  // are astronomically small. The `NX` guard below catches any
  // theoretical collision anyway.
  const ticketId = randomBytes(16).toString("base64url")
  const payload: StoredTicket = {
    email: user.email,
    organizationId: integration.organizationId,
  }

  const stored = await redis.set(
    key("sso", "ticket", ticketId),
    JSON.stringify(payload),
    "EX",
    TICKET_TTL_SECONDS,
    "NX",
  )
  if (stored === null) {
    // Collision (or store rejected for some other reason). Surface as
    // a 500 — the partner can just retry.
    return NextResponse.json(
      {
        error: {
          status: 500,
          message: "Could not allocate ticket. Please retry.",
        },
      },
      { status: 500 },
    )
  }

  return NextResponse.json(
    {
      ticket: ticketId,
      expiresIn: TICKET_TTL_SECONDS,
      // Opaque path partners append to their HR domain. Treat it as
      // a black box — we may change the internal shape in the future
      // (this changed once from `?token=eyJ…` to `?t=<id>` already).
      redirectPath: `/api/sso/altomate?t=${encodeURIComponent(ticketId)}`,
    },
    { status: 201 },
  )
})
