import { NextResponse } from "next/server"
import { z } from "zod"

import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

import { handleAuthEndpointRequest } from "../_shared"

/**
 * POST /api/v1/auth/organizations
 *
 * Returns the AltomateHR organizations a given user administers — the same
 * list POST /api/v1/auth/verify returns at login, but WITHOUT re-checking
 * the password. Lets a first-party companion app (ABPay) refresh its
 * company roster on demand from an existing session.
 *
 * Authentication (dual-mode — see `../_shared`):
 *   - **master key** (`wp_master_*`): partner identity is enough; returns
 *     whatever the user administers (`[]` for non-admins).
 *   - **per-org token** (`wp_live_*`): backward-compat. The user must
 *     administer THAT token's org.
 *
 * Responses:
 *   200 { data: { organizations: [{ id, name }, ...] } }
 *   400 invalid body
 *   403 (per-org mode) the user is not an admin/owner of this token's org
 */
const bodySchema = z.object({
  userId: z.string().trim().min(1, "userId is required."),
})

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

  // Per-org callers may only look up a user who administers THEIR org.
  // Master callers are trusted partner identities — no org to gate on.
  if (ctx.mode === "org") {
    const hasAccess = await organizationRepository.isAdminOfOrganization(
      parsed.data.userId,
      ctx.organizationId,
    )
    if (!hasAccess) {
      return NextResponse.json(
        {
          error: {
            status: 403,
            message:
              "This user is not an admin or owner of the organization this token belongs to.",
          },
        },
        { status: 403 },
      )
    }
  }

  const organizations = await organizationRepository.getAdminOrganizations(
    parsed.data.userId,
  )

  return NextResponse.json({ data: { organizations } })
})
