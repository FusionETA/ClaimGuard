import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Saved login credentials for a single statutory portal (KWSP or
 * PERKESO) per organization. The repository stores rows verbatim;
 * encryption / decryption of the password ciphertext is handled by the
 * SERVICE layer (`portal-credential.service.ts`) using `lib/crypto.ts`.
 *
 * One row per (organizationId, portal) — enforced by a DB unique
 * constraint. `upsert` is keyed off that pair.
 */

export type PortalKind = "KWSP" | "PERKESO"

/// The raw row as stored in DB — `passwordEnc` is the AES-GCM
/// ciphertext (base64). Use the service-layer DTO when handing data to
/// the UI so the plaintext password stays out of the wire whenever
/// possible.
export type PortalCredentialRow = {
  id: string
  organizationId: string
  portal: PortalKind
  userId: string | null
  passwordEnc: string | null
  image: string | null
  secretCode: string | null
  securityPhrase: string | null
  passwordReminder: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type PortalCredentialPatch = {
  userId?: string | null
  passwordEnc?: string | null
  image?: string | null
  secretCode?: string | null
  securityPhrase?: string | null
  passwordReminder?: string | null
  notes?: string | null
}

export const portalCredentialRepository = {
  async listByOrgId(organizationId: string): Promise<PortalCredentialRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.payrollPortalCredential.findMany({
      where: { organizationId },
      orderBy: { portal: "asc" },
    })
    return rows.map(mapRow)
  },

  async getOne(input: {
    organizationId: string
    portal: PortalKind
  }): Promise<PortalCredentialRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.payrollPortalCredential.findUnique({
      where: {
        organizationId_portal: {
          organizationId: input.organizationId,
          portal: input.portal,
        },
      },
    })
    return row ? mapRow(row) : null
  },

  async upsert(input: {
    organizationId: string
    portal: PortalKind
    patch: PortalCredentialPatch
  }): Promise<PortalCredentialRow> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const data = toUpsertData(input.patch)
    const row = await prisma.payrollPortalCredential.upsert({
      where: {
        organizationId_portal: {
          organizationId: input.organizationId,
          portal: input.portal,
        },
      },
      create: {
        organizationId: input.organizationId,
        portal: input.portal,
        ...data,
      },
      update: data,
    })
    return mapRow(row)
  },

  async delete(input: {
    organizationId: string
    portal: PortalKind
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    await prisma.payrollPortalCredential.deleteMany({
      where: {
        organizationId: input.organizationId,
        portal: input.portal,
      },
    })
  },
}

function mapRow(row: any): PortalCredentialRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    portal: row.portal as PortalKind,
    userId: row.userId ?? null,
    passwordEnc: row.passwordEnc ?? null,
    image: row.image ?? null,
    secretCode: row.secretCode ?? null,
    securityPhrase: row.securityPhrase ?? null,
    passwordReminder: row.passwordReminder ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toUpsertData(patch: PortalCredentialPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const copy = <K extends keyof PortalCredentialPatch>(k: K) => {
    if (patch[k] !== undefined) out[k as string] = patch[k]
  }
  copy("userId")
  copy("passwordEnc")
  copy("image")
  copy("secretCode")
  copy("securityPhrase")
  copy("passwordReminder")
  copy("notes")
  return out
}
