import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateUser } from "@/lib/auth/authenticate"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

import { handleAuthEndpointRequest } from "../_shared"

/**
 * POST /api/v1/auth/verify
 *
 * Credential-verification endpoint for first-party companion apps (e.g.
 * ABPay — the Ayu Borneo payroll importer). Verifies a user against
 * AltomateHR's own password database and returns the identity + the orgs
 * they administer, so the companion app can mint its OWN session.
 *
 * Authentication (dual-mode — see `../_shared`):
 *   - **master key** (`wp_master_*`): the natural fit for a companion app
 *     whose owner spans several orgs. Gate: the user administers ≥ 1 org.
 *   - **per-org token** (`wp_live_*`): backward-compat. Gate: the user
 *     administers THAT token's org.
 *
 * SECURITY — `authenticateUser()` checks the password against ANY active
 * user platform-wide, so returning success on the password alone would be
 * a cross-tenant oracle. The ADMIN/OWNER role check + the org gate below
 * are what contain it: only an admin/owner who actually administers an org
 * (the token's org, or any org, per mode) can be verified here.
 *
 * Responses:
 *   200 { data: { id, name, email, role, organizationId, organizationName, organizations } }
 *   400 invalid body
 *   401 invalid email or password (uniform — never leaks whether the email exists)
 *   403 valid credentials but not an admin/owner (of the required scope)
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

  // Only admin-tier accounts may sign in to an external companion app.
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

  // The companies this owner can manage — returned to the app AND used for
  // the master-mode gate.
  const organizations = await organizationRepository.getAdminOrganizations(
    user.userId,
  )

  // Org gate — depends on how the caller authenticated (see `../_shared`).
  const authorized =
    ctx.mode === "master"
      ? organizations.length > 0
      : await organizationRepository.isAdminOfOrganization(
          user.userId,
          ctx.organizationId,
        )
  if (!authorized) {
    return NextResponse.json(
      {
        error: {
          status: 403,
          message:
            ctx.mode === "master"
              ? "This account does not administer any organization."
              : "This account is not an admin or owner of the organization this token belongs to.",
        },
      },
      { status: 403 },
    )
  }

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
