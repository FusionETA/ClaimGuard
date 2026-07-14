import "server-only"

import { Prisma } from "@/generated/prisma/client"

import { getPrismaClient } from "@/lib/prisma"
import type {
  AuditActorRole,
  AuditLogEntry,
  AuditLogFilter,
  AuditStatus,
} from "@/modules/audit/domain/models"

type Row = Prisma.OrganizationAuditLogGetPayload<Record<string, never>>

function mapRow(row: Row): AuditLogEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole as AuditActorRole | null,
    actorEmail: row.actorEmail,
    actorName: row.actorName,
    action: row.action,
    status: row.status as AuditStatus,
    summary: row.summary,
    errorReason: row.errorReason,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata:
      row.metadata == null
        ? null
        : (row.metadata as Record<string, unknown>),
    ipAddress: row.ipAddress,
    partnerInitiated: row.partnerInitiated,
    createdAt: row.createdAt.toISOString(),
  }
}

export const auditLogRepository = {
  /// Write a single audit row. Returns the generated id (mostly for tests).
  /// Throws when the DB isn't configured — the caller decides whether to
  /// swallow (most callers do; an audit miss should never break the user
  /// action that triggered it).
  async create(input: {
    organizationId: string
    actorUserId: string | null
    actorRole: AuditActorRole | null
    actorEmail: string
    actorName: string
    action: string
    status: AuditStatus
    summary: string
    errorReason?: string | null
    targetType?: string | null
    targetId?: string | null
    metadata?: Record<string, unknown> | null
    ipAddress?: string | null
    partnerInitiated?: boolean
  }): Promise<{ id: string }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const created = await prisma.organizationAuditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        actorEmail: input.actorEmail,
        actorName: input.actorName,
        action: input.action,
        status: input.status,
        summary: input.summary,
        errorReason: input.errorReason ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata:
          input.metadata == null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
        ipAddress: input.ipAddress ?? null,
        partnerInitiated: input.partnerInitiated ?? false,
      },
      select: { id: true },
    })
    return created
  },

  /// Paged read for the admin Activity log tab. Newest first. Cursor-
  /// paginates on `(createdAt DESC, id DESC)` — pass the last entry's `id`
  /// from the previous page as `cursor`.
  async listForOrganization(
    organizationId: string,
    filter: AuditLogFilter = {},
  ): Promise<{ entries: AuditLogEntry[]; nextCursor: string | null }> {
    const prisma = getPrismaClient()
    if (!prisma) return { entries: [], nextCursor: null }

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const where: Prisma.OrganizationAuditLogWhereInput = {
      organizationId,
    }
    if (filter.actionPrefix) {
      where.action = { startsWith: filter.actionPrefix }
    }
    // Block-list of prefixes to hide entirely. Applied as an AND of
    // NOT-startsWith clauses so the DB pages over actually-visible
    // rows — without this we'd pull (say) 100 attendance rows, throw
    // 95 away in JS, and show the admin a near-empty page.
    if (filter.excludeActionPrefixes && filter.excludeActionPrefixes.length > 0) {
      where.AND = filter.excludeActionPrefixes.map((prefix) => ({
        NOT: { action: { startsWith: prefix } },
      }))
    }
    if (filter.status) where.status = filter.status
    if (filter.actorUserId) where.actorUserId = filter.actorUserId
    if (filter.fromIso || filter.toIso) {
      where.createdAt = {}
      if (filter.fromIso) where.createdAt.gte = new Date(filter.fromIso)
      if (filter.toIso) where.createdAt.lt = new Date(filter.toIso)
    }

    const rows = await prisma.organizationAuditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // fetch one extra so we know if there's a next page
      ...(filter.cursor
        ? { cursor: { id: filter.cursor }, skip: 1 }
        : {}),
    })

    const hasMore = rows.length > limit
    const sliced = hasMore ? rows.slice(0, limit) : rows
    return {
      entries: sliced.map(mapRow),
      nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
    }
  },

  /// Daily cron uses this. Deletes everything older than `cutoff` and
  /// returns the row count so the cron can log it.
  async deleteOlderThan(cutoff: Date): Promise<{ deleted: number }> {
    const prisma = getPrismaClient()
    if (!prisma) return { deleted: 0 }
    const result = await prisma.organizationAuditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    return { deleted: result.count }
  },

  /**
   * Cross-org lookup of recent audit entries filtered by `action` +
   * (optional) `actorRole IN (…)`. Used by cron / reporting paths
   * that need a slice across every org — the caller is expected to
   * be an OPERATOR flow (bearer-authed cron endpoint), not a per-org
   * admin request. Ordered newest-first.
   *
   * Returns lightweight rows (org name + actor identity fields) —
   * enough for a WhatsApp / email summary without dragging the full
   * AuditLogEntry mapper into the shape.
   */
  async listRecentByAction(input: {
    action: string
    actorRoles?: string[]
    since: Date
  }): Promise<
    Array<{
      createdAt: Date
      actorUserId: string | null
      actorName: string
      actorEmail: string
      actorRole: string | null
      organizationName: string
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.organizationAuditLog.findMany({
      where: {
        action: input.action,
        createdAt: { gte: input.since },
        ...(input.actorRoles && input.actorRoles.length > 0
          ? { actorRole: { in: input.actorRoles } }
          : {}),
      },
      select: {
        createdAt: true,
        actorUserId: true,
        actorName: true,
        actorEmail: true,
        actorRole: true,
        organization: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    })
    return rows.map((r) => ({
      createdAt: r.createdAt,
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      actorEmail: r.actorEmail,
      actorRole: r.actorRole,
      organizationName: r.organization?.name ?? "",
    }))
  },
}
