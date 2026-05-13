import { NextResponse } from "next/server"
import { z } from "zod"

import { generateApiToken } from "@/lib/api-auth"
import { API_SCOPE_CATALOG } from "@/lib/api-scopes"
import { handleMasterApiRequest } from "@/lib/master-api-auth"
import { getPrismaClient } from "@/lib/prisma"

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
 * NOTE: this endpoint deliberately does NOT create an admin user. The
 * tenant is API-only — the partner's own admin portal is the surface
 * customers use, not AltomateHR's. If we ever need to add direct portal
 * login for a tenant, we'll add an `admin` block to the request body
 * (or a separate admin-users endpoint) — design notes are in the
 * conversation history but the code is intentionally minimal here.
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

  const prisma = getPrismaClient()
  if (!prisma) {
    return NextResponse.json(
      { error: { status: 503, message: "Database is not configured." } },
      { status: 503 },
    )
  }

  const name = parsed.data.name.trim()

  // Pre-check the unique name so we can give a 409 instead of a generic
  // 500 from the unique-violation. Race-safe enough for our purposes —
  // the create() below is still the source of truth.
  const existing = await prisma.organization.findUnique({
    where: { name },
    select: { id: true },
  })
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

  // Wrap the org + integration create in a single transaction so a
  // partial state (org without a token) cannot exist. Either both rows
  // commit or neither does.
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name },
      select: { id: true, name: true },
    })

    const integration = await tx.apiIntegration.create({
      data: {
        organizationId: org.id,
        name: tokenLabel,
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        // Spread to detach from the readonly tuple type so Prisma
        // accepts a mutable string[] for the Json column.
        scopes: [...API_SCOPE_CATALOG],
        issuedByMasterKeyId: ctx.masterKey.id,
      },
      select: { id: true },
    })

    return { org, integration }
  })

  const response = NextResponse.json(
    {
      organization: {
        id: result.org.id,
        name: result.org.name,
      },
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
  const prisma = getPrismaClient()
  if (!prisma) {
    return NextResponse.json({ data: [] })
  }

  // Find organizations that have at least one ApiIntegration issued by
  // this master key. We dedupe by org id (a partner may have rotated
  // tokens, leaving multiple integrations against the same org).
  type IntegrationWithOrg = {
    organizationId: string
    createdAt: Date
    organization: { id: string; name: string; createdAt: Date }
  }

  const integrations = (await prisma.apiIntegration.findMany({
    where: { issuedByMasterKeyId: ctx.masterKey.id },
    orderBy: { createdAt: "desc" },
    select: {
      organizationId: true,
      createdAt: true,
      organization: {
        select: { id: true, name: true, createdAt: true },
      },
    },
  })) as IntegrationWithOrg[]

  const seen = new Set<string>()
  const orgs: Array<{ id: string; name: string; createdAt: string }> = []
  for (const row of integrations) {
    if (seen.has(row.organizationId)) continue
    seen.add(row.organizationId)
    orgs.push({
      id: row.organization.id,
      name: row.organization.name,
      createdAt: row.organization.createdAt.toISOString(),
    })
  }

  return NextResponse.json({ data: orgs, total: orgs.length })
})
