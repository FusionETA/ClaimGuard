import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { authenticateUser } from "@/lib/auth/authenticate"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/auth/verify
 *
 * Credential-verification endpoint for external, first-party companion
 * apps (e.g. ABPay — the Ayu Borneo payroll importer). Lets an external
 * app authenticate a user against AltomateHR's own password database
 * instead of maintaining a separate credential store. The external app
 * then mints its OWN session (JWT/cookie) from the returned identity —
 * this endpoint only answers "are these credentials valid, and is this
 * person an admin/owner of my org?".
 *
 * Authentication: per-organization API token (`Authorization: Bearer
 * wp_live_*`), same as every other /api/v1 route. No extra scope is
 * required (`[]`) — the org-scoping below is what makes it safe.
 *
 * SECURITY — why the org check matters:
 *   `authenticateUser()` verifies the password against ANY active user
 *   with that email, platform-wide. Returning success on that alone
 *   would turn any partner's token into a cross-tenant password oracle
 *   (brute-force another customer's users). So after the password check
 *   we require the user to be an ADMIN/OWNER of the SPECIFIC org this
 *   token belongs to — mirroring the same gate the SSO-ticket route
 *   uses (`isAdminOfOrganization`). A token can therefore only verify
 *   credentials for its own tenant's admins.
 *
 * Responses:
 *   200 { data: { id, name, email, role, organizationId, organizationName } }
 *   400 invalid body
 *   401 invalid email or password (uniform — never leaks whether the
 *       email exists)
 *   403 valid credentials but not an admin/owner of this token's org
 */

const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .toLowerCase(),
  password: z.string().min(1, "Password is required."),
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

  const result = await authenticateUser({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  // Uniform 401 on any failure — don't distinguish "no such email" from
  // "wrong password".
  if (!result.success) {
    return NextResponse.json(
      { error: { status: 401, message: "Invalid email or password." } },
      { status: 401 },
    )
  }

  const user = result.user

  // Only admin-tier accounts may sign in to an external companion app,
  // and only for the org this token was issued for (see SECURITY note).
  if (user.role !== "ADMIN" && user.role !== "OWNER") {
    return NextResponse.json(
      {
        error: {
          status: 403,
          message: "This account is not permitted to sign in here.",
        },
      },
      { status: 403 },
    )
  }

  const hasAccess = await organizationRepository.isAdminOfOrganization(
    user.userId,
    integration.organizationId,
  )
  if (!hasAccess) {
    return NextResponse.json(
      {
        error: {
          status: 403,
          message:
            "This account is not an admin or owner of the organization this token belongs to.",
        },
      },
      { status: 403 },
    )
  }

  // The companies this owner can manage in AltomateHR — ABPay lists these
  // so the owner can connect a per-company API token to each. Reuses the
  // same source the admin org-switcher uses (primary org + linked orgs).
  const organizations = await organizationRepository.getAdminOrganizations(
    user.userId,
  )

  return NextResponse.json({
    data: {
      id: user.userId,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId ?? null,
      organizationName: user.organizationName ?? null,
      organizations,
    },
  })
})
