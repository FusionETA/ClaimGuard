import { NextResponse } from "next/server"
import { z } from "zod"

import { signSsoToken } from "@/lib/auth/sso-token"
import { handleMasterApiRequest } from "@/lib/master-api-auth"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/admin/sso-ticket
 *
 * Server-to-server (master-key authenticated). Altomate Accounting calls
 * this to obtain a short-lived SSO token for one of its provisioned
 * owners/admins, then redirects the customer's browser to:
 *
 *   <AltomateHR>/api/sso/altomate?token=<token>
 *
 * HR signs the token with its OWN AUTH_SECRET and verifies it on the
 * callback — so there is no shared SSO secret to manage. The master key
 * is the only credential, and it never leaves the server-to-server hop.
 *
 * The email MUST already resolve to an admin/owner in AltomateHR
 * (provision via POST /api/v1/admin/organizations with an `owner` block
 * first). We return 404 otherwise so the partner gets a clear signal.
 */

const ticketSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .toLowerCase(),
})

export const POST = handleMasterApiRequest(async (request) => {
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

  const { token, expiresIn } = signSsoToken({ email: user.email })

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
