import "server-only"

import { Prisma } from "@/generated/prisma/client"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Fusioneta-side accountability trail for the SUPERADMIN feature.
 * Every action a superadmin (email in SUPERADMIN_EMAILS) takes inside
 * a customer's org lands here with the REAL actor identity — parallel
 * to the org's own OrganizationAuditLog row which is rewritten to
 * "System (Support)" to hide the specific staff member from the
 * customer.
 *
 * No retention prune — kept indefinitely for compliance.
 */
export const superadminAuditRepository = {
  /**
   * Insert one row. Fire-and-forget from the caller — errors are
   * swallowed and console-logged by the service (never let an audit
   * miss break the user's action).
   */
  async create(input: {
    actorUserId: string | null
    actorEmail: string
    actorName: string
    targetOrganizationId: string
    targetOrganizationName: string
    action: string
    summary: string
    metadata?: Record<string, unknown> | null
  }): Promise<{ id: string }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const row = await prisma.superadminAuditLog.create({
      data: {
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        actorName: input.actorName,
        targetOrganizationId: input.targetOrganizationId,
        targetOrganizationName: input.targetOrganizationName,
        action: input.action,
        summary: input.summary,
        metadata:
          input.metadata == null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      },
      select: { id: true },
    })
    return row
  },

  /**
   * Recent activity across all superadmins and all target orgs — used
   * by an internal Fusioneta-only page (not shipped in v1). Newest
   * first; capped at 500 rows.
   */
  async listRecent(input?: {
    limit?: number
  }): Promise<
    Array<{
      id: string
      actorEmail: string
      actorName: string
      targetOrganizationId: string
      targetOrganizationName: string
      action: string
      summary: string
      createdAt: Date
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const limit = Math.min(Math.max(input?.limit ?? 100, 1), 500)
    const rows = await prisma.superadminAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        actorEmail: true,
        actorName: true,
        targetOrganizationId: true,
        targetOrganizationName: true,
        action: true,
        summary: true,
        createdAt: true,
      },
    })
    return rows
  },
}
