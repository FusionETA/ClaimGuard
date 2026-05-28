import { NextResponse } from "next/server"
import { z } from "zod"

import { signSsoToken } from "@/lib/auth/sso-token"
import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/admin/sso-ticket
 *
 * Server-to-server SSO ticket minter. Altomate Accounting calls this to
 * obtain a short-lived SSO token for one of its provisioned owners/admins,
 * then redirects the customer's browser to:
 *
 *   <AltomateHR>/api/sso/altomate?token=<token>
 *
 * Authentication: **per-organization API token** (`Authorization: Bearer
 * wp_live_*`). The token's `organizationId` is the target the customer
 * wants to land in. This replaced the earlier master-key auth so that
 * Altomate Accounting — which has an organization dropdown — can pick
 * WHICH org the customer enters (a single owner can own many companies;
 * defaulting to "primary org" landed them in the wrong place).
 *
 * The master key is now only used to CREATE organizations
 * (POST /api/v1/admin/organizations). Once an org exists and has its own
 * `wp_live_*` token, SSO uses that token.
 *
 * Email rules:
 *   - Must already resolve to an ADMIN/OWNER (provision via the org
 *     creation endpoint first).
 *   - Must have admin access to the SPECIFIC organization the token
 *     belongs to (either via `AdminOrganization` link or by being the
 *     legacy single-org admin whose `User.organizationId` matches).
 *   - 404 otherwise — clear signal so the partner can fix.
 *
 * HR signs the resulting JWT with its own `AUTH_SECRET` and verifies it
 * on the callback — no shared secret with Accounting.
 */

const ticketSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .toLowerCase(),
})

// No scopes required — any active per-org token can mint an SSO ticket.
// (We can tighten this later by adding an `sso:create-ticket` scope.)
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

  // Verify the email has admin access to THE specific org this token
  // belongs to. Same email might own multiple orgs — the per-org token
  // is the differentiator. Returns true when either an AdminOrganization
  // row exists OR the user is the legacy single-org admin
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

  const { token, expiresIn } = signSsoToken({
    email: user.email,
    organizationId: integration.organizationId,
  })

  return NextResponse.json(
    {
      token,
      expiresIn,
      // Convenience: the path to redirect the browser to. Prepend your
      // AltomateHR origin (e.g. https://hr.altomate.io).
      redirectPath: `/api/sso/altomate?token=${encodeURIComponent(token)}`,
    },
    { status: 201 },
  )
})
