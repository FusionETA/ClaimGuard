import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Thin repo for `MasterApiKey` rows. Token generation lives in
 * `lib/master-api-auth.ts`; this module only handles persistence.
 */

export type MasterApiKeyListItem = {
  id: string
  partnerName: string
  tokenPrefix: string
  active: boolean
  notes: string | null
  createdAt: string
  lastUsedAt: string | null
  /// Number of organizations auto-issued via this master key. Useful in
  /// the (future) admin UI to flag a partner that has provisioned a lot
  /// of tenants.
  issuedOrganizationCount: number
}

export const masterApiKeyRepository = {
  async list(): Promise<MasterApiKeyListItem[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    type MasterApiKeyRow = {
      id: string
      partnerName: string
      tokenPrefix: string
      active: boolean
      notes: string | null
      createdAt: Date
      lastUsedAt: Date | null
      _count: { issuedIntegrations: number }
    }

    const rows = (await prisma.masterApiKey.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { issuedIntegrations: true } } },
    })) as MasterApiKeyRow[]

    return rows.map((row) => ({
      id: row.id,
      partnerName: row.partnerName,
      tokenPrefix: row.tokenPrefix,
      active: row.active,
      notes: row.notes ?? null,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      issuedOrganizationCount: row._count.issuedIntegrations,
    }))
  },

  async create(input: {
    partnerName: string
    tokenHash: string
    tokenPrefix: string
    notes?: string | null
  }): Promise<{ id: string }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const row = await prisma.masterApiKey.create({
      data: {
        partnerName: input.partnerName.trim(),
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        notes: input.notes?.trim() || null,
      },
      select: { id: true },
    })
    return { id: row.id }
  },

  async setActive(input: { id: string; active: boolean }): Promise<{ ok: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false }

    const result = await prisma.masterApiKey.updateMany({
      where: { id: input.id },
      data: { active: input.active },
    })
    return { ok: result.count > 0 }
  },

  async delete(input: { id: string }): Promise<{ ok: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false }

    const result = await prisma.masterApiKey.deleteMany({
      where: { id: input.id },
    })
    return { ok: result.count > 0 }
  },
}
