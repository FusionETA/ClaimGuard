import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * DELETE /api/v1/admin/admins/[email]
 *
 * Partner endpoint: remove an ADMIN from the organization this per-org
 * API token belongs to. Counterpart to POST /api/v1/admin/admins.
 *
 * Auth: per-org `wp_live_*` token (Authorization: Bearer …). The
 * token's organization is the org we're removing the admin from. No
 * scopes required for now.
 *
 * URL param: `email` — URL-encoded email of the admin to remove. The
 * organisation context is fully in the token; the email identifies
 * WHICH admin within that org.
 *
 * Behaviour:
 *   - Email not found in our system            → 404.
 *   - Email is not an admin of THIS org         → 404 (same shape so a
 *                                                 caller can't probe).
 *   - Email is the OWNER of this org            → 409. Owners can't be
 *                                                 removed via the
 *                                                 partner API. (The
 *                                                 owner is the partner's
 *                                                 contact for the org.)
 *   - Otherwise (existing ADMIN linked to this org) → unlink via
 *                                                 AdminOrganization
 *                                                 and return 200.
 *
 * The User row itself is NEVER deleted — if the admin is linked to
 * other orgs (via additional AdminOrganization rows) they keep
 * access to those. If they had this org as their "primary"
 * (`User.organizationId`), the repo helper reassigns to a remaining
 * org or nulls it out.
 */

const paramsSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .transform((v) => v.trim().toLowerCase()),
})

export const DELETE = handleApiRequest<{ email: string }>(
  [],
  async (_request, { integration, params }) => {
    // Next.js dynamic params already URL-decode the path segment, so
    // raw `params.email` is the decoded address. Validate shape via Zod.
    const parsed = paramsSchema.safeParse({ email: params.email })
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            status: 400,
            message: "Invalid email in path.",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    const email = parsed.data.email
    const organizationId = integration.organizationId

    const user = await organizationRepository.findUserByEmail(email)
    if (!user) {
      return NextResponse.json(
        { error: { status: 404, message: "No admin with that email." } },
        { status: 404 },
      )
    }

    // Owners can't be removed via the partner API — they were the
    // org's contact at provisioning time. Surfacing a distinct 409
    // lets the partner see why instead of getting a generic 404.
    if (user.role === "OWNER") {
      return NextResponse.json(
        {
          error: {
            status: 409,
            message:
              "Owners can't be removed via this endpoint. Contact us if the owner needs to be transferred.",
          },
        },
        { status: 409 },
      )
    }

    const isLinked = await organizationRepository.isAdminOfOrganization(
      user.id,
      organizationId,
    )
    if (!isLinked) {
      return NextResponse.json(
        {
          error: {
            status: 404,
            message: "That email is not an admin of this organization.",
          },
        },
        { status: 404 },
      )
    }

    // Unlink + repo handles re-pointing `User.organizationId` to a
    // remaining org (or null) when this org was their primary.
    await organizationRepository.unlinkAdminFromOrganization(
      user.id,
      organizationId,
    )

    return NextResponse.json(
      {
        admin: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        removed: true,
      },
      { status: 200 },
    )
  },
)
