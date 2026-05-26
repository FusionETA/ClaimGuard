import { NextResponse } from "next/server"
import { z } from "zod"

import { generateApiToken } from "@/lib/api-auth"
import { API_SCOPE_CATALOG } from "@/lib/api-scopes"
import { handleMasterApiRequest } from "@/lib/master-api-auth"
import { apiIntegrationRepository } from "@/modules/organization/infrastructure/api-integration.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/admin/organizations
 *
 * Provisions a new AltomateHR Organization on behalf of an integration
 * partner. Authenticates with a master API key (wp_master_*) and
 * returns:
 *   - the new organization id + name
 *   - a per-org `ApiIntegration` token (wp_live_*) with all 17 scopes
 *
 * The per-org token is the SECRET — it's shown exactly once in this
 * response and never again. The partner's backend must persist it
 * alongside the customer record so subsequent /api/v1/* calls can
 * authenticate as that organization.
 *
 * Optionally accepts an `owner` block ({ email, name }). When present,
 * we provision the paying customer's OWNER account for this org so they
 * can SSO straight into the AltomateHR admin dashboard (see
 * /api/sso/altomate). The owner has no usable password — they only ever
 * enter via the signed SSO hand-off from Altomate Accounting. Omit the
 * block to keep the tenant API-only (no portal login).
 *
 * NOTE on default scopes: today the auto-issued token receives every
 * scope in the catalog. When per-plan gating ships, this list will be
 * narrowed based on the partner's plan tier (recorded on MasterApiKey
 * or a future MasterApiKeyPlan join).
 */

const createOrgSchema = z.object({
  // AltomateHR `Organization.name` is unique. 2..120 chars matches the
  // existing admin "create org" form's bounds.
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  // Optional human-readable label for the auto-issued token. Lets the
  // partner attribute the token in the admin UI later
  // ("Acme HR portal — Customer A").
  tokenLabel: z.string().trim().max(120).optional(),
  // Optional OWNER to provision for the new org. When the partner
  // (Altomate Accounting) sends this, we create the paying customer's
  // OWNER account so they can SSO straight into the admin dashboard.
  // No password is accepted — the owner only ever signs in via the
  // signed SSO hand-off.
  owner: z
    .object({
      email: z
        .string()
        .trim()
        .min(1, "Owner email is required.")
        .email("Enter a valid owner email.")
        .toLowerCase(),
      name: z
        .string()
        .trim()
        .min(1, "Owner name is required.")
        .max(120, "Owner name is too long."),
    })
    .optional(),
})

export const POST = handleMasterApiRequest(async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { status: 400, message: "Invalid JSON body." } },
      { status: 400 },
    )
  }

  const parsed = createOrgSchema.safeParse(body)
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

  const name = parsed.data.name.trim()

  const existing = await organizationRepository.findOrganizationByName(name)
  if (existing) {
    return NextResponse.json(
      {
        error: {
          status: 409,
          message: `An organization named "${name}" already exists.`,
        },
      },
      { status: 409 },
    )
  }

  const token = generateApiToken()
  const tokenLabel =
    parsed.data.tokenLabel?.trim() ||
    `${ctx.masterKey.partnerName} (auto-issued)`

  const result = await organizationRepository.createOrganizationWithApiIntegration({
    organizationName: name,
    integration: {
      name: tokenLabel,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      scopes: API_SCOPE_CATALOG,
      issuedByMasterKeyId: ctx.masterKey.id,
    },
  })

  // Optionally provision the OWNER (paying customer) for this org so they
  // can SSO straight into the admin dashboard. No password is set — they
  // authenticate via the signed SSO hand-off from Altomate Accounting.
  let owner: { id: string; email: string; name: string; created: boolean } | null =
    null
  if (parsed.data.owner) {
    owner = await organizationRepository.createOwnerForOrganization({
      organizationId: result.org.id,
      email: parsed.data.owner.email,
      name: parsed.data.owner.name,
    })
  }

  const response = NextResponse.json(
    {
      organization: {
        id: result.org.id,
        name: result.org.name,
      },
      ...(owner
        ? {
            owner: {
              id: owner.id,
              email: owner.email,
              name: owner.name,
              created: owner.created,
            },
          }
        : {}),
      apiToken: {
        // The raw secret. Exposed exactly once — partner MUST persist
        // this on their side immediately.
        secret: token.raw,
        prefix: token.prefix,
        scopes: [...API_SCOPE_CATALOG],
        integrationId: result.integration.id,
      },
    },
    { status: 201 },
  )

  // Internal flag for the master-audit-log writer (see
  // handleMasterApiRequest); stripped before sending to the client.
  response.headers.set("X-Created-Organization-Id", result.org.id)

  return response
})

/**
 * GET /api/v1/admin/organizations
 *
 * Lists every Organization this master key has provisioned. Useful for
 * a partner's reconciliation flow — "what tenants do I have on
 * AltomateHR, and when were they created". Does NOT return tokens —
 * those are write-only (returned only at create time, then opaque).
 */
export const GET = handleMasterApiRequest(async (_request, ctx) => {
  const orgs = await apiIntegrationRepository.listOrganizationsForMasterKey(
    ctx.masterKey.id,
  )
  return NextResponse.json({ data: orgs, total: orgs.length })
})
