import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/admin/admins
 *
 * Partner endpoint: add an ADMIN to the organization THIS per-org API
 * token belongs to. Used by Altomate Accounting to grant access to
 * additional team members after the org has been created (the OWNER is
 * provisioned at org-creation time via POST /api/v1/admin/organizations,
 * not here).
 *
 * Auth: per-org `wp_live_*` token (Authorization: Bearer …). The
 * token's organization is the target. No scopes required for now.
 *
 * Body:
 *   { email: string, name: string }
 *
 * Behaviour:
 *   - Brand-new email                 → create User { role: ADMIN } and
 *                                       link via AdminOrganization.
 *                                       Returns 201 { created: true,
 *                                       linked: true }.
 *   - Existing ADMIN/OWNER (other org) → link to this org via
 *                                       AdminOrganization (no role
 *                                       change). Returns 200
 *                                       { created: false, linked: true }.
 *   - Existing ADMIN already on this org → no-op. Returns 200
 *                                       { created: false, linked: false }.
 *   - Existing user with role EMPLOYEE / SUPERVISOR → 409 conflict (we
 *                                       refuse to silently promote a
 *                                       non-admin account; the partner
 *                                       should pick a different email or
 *                                       contact us).
 *
 * The new admin signs in via the SSO hand-off (POST
 * /api/v1/admin/sso-ticket), never with a password — we mint an
 * unusable random password just to satisfy the schema.
 */

const createAdminSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .toLowerCase(),
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(120, "Name is too long."),
})

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

  const parsed = createAdminSchema.safeParse(body)
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

  const { email, name } = parsed.data
  const organizationId = integration.organizationId

  const existing = await organizationRepository.findUserByEmail(email)

  // Refuse to silently promote a non-admin account into an admin role
  // for this org. Partner should use a fresh email or contact us.
  if (existing && existing.role !== "ADMIN" && existing.role !== "OWNER") {
    return NextResponse.json(
      {
        error: {
          status: 409,
          message:
            "That email belongs to a non-admin user in the system. Use a different email.",
        },
      },
      { status: 409 },
    )
  }

  // Already an admin/owner of THIS org → no-op (idempotent).
  if (existing) {
    const alreadyHere = await organizationRepository.isAdminOfOrganization(
      existing.id,
      organizationId,
    )
    if (alreadyHere) {
      return NextResponse.json(
        {
          admin: {
            id: existing.id,
            email: existing.email,
            name: existing.name,
            role: existing.role,
          },
          created: false,
          linked: false,
        },
        { status: 200 },
      )
    }

    // Admin/owner from another org → just add the AdminOrganization
    // row. Don't touch their role or primary organizationId.
    await organizationRepository.linkAdminToOrganization(
      existing.id,
      organizationId,
    )
    return NextResponse.json(
      {
        admin: {
          id: existing.id,
          email: existing.email,
          name: existing.name,
          role: existing.role,
        },
        created: false,
        linked: true,
      },
      { status: 200 },
    )
  }

  // Brand new email — create the User as ADMIN. The random unusable
  // password matches the pattern in createOwnerForOrganization: SSO is
  // the only sign-in path, so no one ever needs (or can find) this
  // value. createAdminForOrganization throws on email collision —
  // we've already guarded against that above, but we catch defensively.
  const password = randomBytes(24).toString("base64url")
  try {
    const created = await organizationRepository.createAdminForOrganization({
      organizationId,
      email,
      name,
      password,
    })
    return NextResponse.json(
      {
        admin: {
          id: created.id,
          email: created.email,
          name: created.name,
          role: "ADMIN",
        },
        created: true,
        linked: true,
      },
      { status: 201 },
    )
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          status: 500,
          message:
            err instanceof Error ? err.message : "Could not create admin.",
        },
      },
      { status: 500 },
    )
  }
})
