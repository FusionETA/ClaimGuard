import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/auth/organizations
 *
 * Returns the AltomateHR organizations a given user administers — the same
 * list POST /api/v1/auth/verify returns at login, but WITHOUT re-checking
 * the password. Lets a first-party companion app (ABPay) refresh its
 * company roster on demand from an existing session, instead of only being
 * able to re-sync at login.
 *
 * Authentication: per-organization API token (`Authorization: Bearer
 * wp_live_*`), same as every /api/v1 route. No scope required (`[]`) — the
 * org-admin gate below is what makes it safe.
 *
 * SECURITY — mirrors /auth/verify: we only return a user's org list if
 * that user is an ADMIN/OWNER of the SPECIFIC org this token belongs to
 * (`isAdminOfOrganization`). A partner token can therefore only enumerate
 * orgs for its own tenant's admins, never for arbitrary user ids.
 *
 * Responses:
 *   200 { data: { organizations: [{ id, name }, ...] } }
 *   400 invalid body
 *   403 the user is not an admin/owner of this token's org
 */
const bodySchema = z.object({
  userId: z.string().trim().min(1, "userId is required."),
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

  // Same gate as /auth/verify: only return this user's org list if they
  // actually administer the org this token belongs to.
  const hasAccess = await organizationRepository.isAdminOfOrganization(
    parsed.data.userId,
    integration.organizationId,
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

  const organizations = await organizationRepository.getAdminOrganizations(
    parsed.data.userId,
  )

  return NextResponse.json({ data: { organizations } })
})
