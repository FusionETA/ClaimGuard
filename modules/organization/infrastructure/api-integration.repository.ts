import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Thin repo for `ApiIntegration` rows. Token creation logic lives in
 * `lib/api-auth.ts` (which knows how to generate + hash); this module
 * only handles persistence.
 */

export type ApiIntegrationListItem = {
  id: string
  name: string
  tokenPrefix: string
  scopes: string[]
  active: boolean
  createdAt: string
  lastUsedAt: string | null
}

export const apiIntegrationRepository = {
  /**
   * Distinct organisations that a master key has provisioned, sorted
   * newest-first. A master key can rotate tokens against the same org —
   * we dedupe so the partner sees one row per customer, not per token.
   */
  async listOrganizationsForMasterKey(
    masterKeyId: string,
  ): Promise<Array<{ id: string; name: string; createdAt: string }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    type IntegrationWithOrg = {
      organizationId: string
      createdAt: Date
      organization: { id: string; name: string; createdAt: Date }
    }

    const rows = (await prisma.apiIntegration.findMany({
      where: { issuedByMasterKeyId: masterKeyId },
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
    for (const row of rows) {
      if (seen.has(row.organizationId)) continue
      seen.add(row.organizationId)
      orgs.push({
        id: row.organization.id,
        name: row.organization.name,
        createdAt: row.organization.createdAt.toISOString(),
      })
    }
    return orgs
  },

  async listForOrganization(
    organizationId: string,
  ): Promise<ApiIntegrationListItem[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    type ApiIntegrationRow = {
      id: string
      name: string
      tokenPrefix: string
      scopes: unknown
      active: boolean
      createdAt: Date
      lastUsedAt: Date | null
    }

    const rows = (await prisma.apiIntegration.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    })) as ApiIntegrationRow[]

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      // Stored as `Json` — coerce to string[].
      scopes: Array.isArray(row.scopes)
        ? row.scopes.filter((s: unknown): s is string => typeof s === "string")
        : [],
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }))
  },

  async create(input: {
    organizationId: string
    name: string
    tokenHash: string
    tokenPrefix: string
    scopes: string[]
  }): Promise<{ id: string }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const row = await prisma.apiIntegration.create({
      data: {
        organizationId: input.organizationId,
        name: input.name.trim(),
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        scopes: input.scopes,
      },
      select: { id: true },
    })
    return { id: row.id }
  },

  /**
   * Soft-deactivate a token. We keep the row + its audit log instead of
   * hard-deleting so the integration's history is preserved for
   * compliance review. Set `active: true` to re-enable later.
   */
  async setActive(input: {
    organizationId: string
    integrationId: string
    active: boolean
  }): Promise<{ ok: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false }

    const result = await prisma.apiIntegration.updateMany({
      where: { id: input.integrationId, organizationId: input.organizationId },
      data: { active: input.active },
    })
    return { ok: result.count > 0 }
  },

  /**
   * Permanent delete — only used by the admin "remove integration"
   * action. Cascades the `ApiAuditLog` rows for that integration.
   */
  async deleteForOrganization(input: {
    organizationId: string
    integrationId: string
  }): Promise<{ ok: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false }

    const result = await prisma.apiIntegration.deleteMany({
      where: { id: input.integrationId, organizationId: input.organizationId },
    })
    return { ok: result.count > 0 }
  },

  /**
   * List EVERY token across EVERY organisation. Joins the org name in
   * so the internal admin page can show "token <name> · org <orgName>".
   *
   * Only the gated `/internal/api-scopes` page calls this — there is no
   * tenant scoping by design (that's the whole point of the internal
   * page). Don't call this from anywhere else.
   */
  async listAllTokensWithOrg(): Promise<
    Array<
      ApiIntegrationListItem & {
        organizationId: string
        organizationName: string
      }
    >
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    type Row = {
      id: string
      name: string
      tokenPrefix: string
      scopes: unknown
      active: boolean
      createdAt: Date
      lastUsedAt: Date | null
      organizationId: string
      organization: { name: string }
    }

    const rows = (await prisma.apiIntegration.findMany({
      orderBy: [
        { organization: { name: "asc" } },
        { createdAt: "desc" },
      ],
      include: { organization: { select: { name: true } } },
    })) as Row[]

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      scopes: Array.isArray(row.scopes)
        ? row.scopes.filter(
            (s: unknown): s is string => typeof s === "string",
          )
        : [],
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
    }))
  },

  /**
   * Overwrite the scope set on a single token (any org). Used by the
   * internal admin page's per-token editor.
   *
   * The caller is responsible for validating the scope strings against
   * `API_SCOPE_CATALOG` — this repo just persists what it's given.
   */
  async setScopes(input: {
    integrationId: string
    scopes: string[]
  }): Promise<{
    ok: boolean
    /// The token's organisationId — needed by the caller to write an
    /// audit row to the right org. Null when the token doesn't exist
    /// (ok: false) or the DB isn't reachable.
    organizationId: string | null
    /// Existing scopes BEFORE the update. Used by the audit caller to
    /// describe what changed (which scopes were granted vs revoked).
    previousScopes: string[]
  }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false, organizationId: null, previousScopes: [] }
    // Load the existing row first so we can return the previous scopes
    // + org context for the audit caller. Two queries instead of one is
    // fine — this endpoint is admin-only and very low traffic.
    const existing = await prisma.apiIntegration.findUnique({
      where: { id: input.integrationId },
      select: { organizationId: true, scopes: true },
    })
    if (!existing) {
      return { ok: false, organizationId: null, previousScopes: [] }
    }
    const result = await prisma.apiIntegration.updateMany({
      where: { id: input.integrationId },
      data: { scopes: input.scopes },
    })
    const previousScopes = Array.isArray(existing.scopes)
      ? (existing.scopes as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : []
    return {
      ok: result.count > 0,
      organizationId: existing.organizationId,
      previousScopes,
    }
  },
}
