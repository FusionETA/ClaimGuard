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
}
