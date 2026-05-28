import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type { AppRole } from "@/lib/auth/types"
import { auditLogRepository } from "@/modules/audit/infrastructure/audit-log.repository"
import type {
  AuditActorRole,
  AuditLogEntry,
  AuditLogFilter,
  AuditStatus,
} from "@/modules/audit/domain/models"

/**
 * Public surface for writing + reading the per-org audit log.
 *
 * Writers must never let an audit failure block the user action that
 * triggered it. `writeAudit` swallows errors internally and just
 * console-logs them. Callers should not wrap it in try/catch.
 */

function appRoleToActorRole(role: AppRole | null | undefined): AuditActorRole | null {
  if (!role) return null
  if (role === "ADMIN" || role === "OWNER" || role === "SUPERVISOR" || role === "EMPLOYEE") {
    return role
  }
  return null
}

export type WriteAuditInput = {
  organizationId: string
  /// Pass the resolved session for the human path, OR null for system /
  /// cron / partner-API paths (then provide `partnerEmail` / "system").
  actor:
    | {
        userId: string
        email: string
        name: string
        role: AppRole
      }
    | {
        kind: "SYSTEM"
        name?: string // defaults to "System"
      }
    | {
        kind: "PARTNER_API"
        integrationName: string
        partnerEmail?: string // optional human label
      }
  action: string
  status: AuditStatus
  summary: string
  errorReason?: string | null
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown> | null
  ipAddress?: string | null
  partnerInitiated?: boolean
}

/// Write a single audit row. Fire-and-forget — failures log to console
/// but never throw. Callers should NOT await this in a way that
/// affects user-visible latency for critical paths.
export async function writeAudit(input: WriteAuditInput): Promise<void> {
  try {
    let actorUserId: string | null = null
    let actorRole: AuditActorRole | null = null
    let actorEmail: string
    let actorName: string
    let partnerInitiated = input.partnerInitiated ?? false

    if ("userId" in input.actor) {
      actorUserId = input.actor.userId
      actorRole = appRoleToActorRole(input.actor.role)
      actorEmail = input.actor.email
      actorName = input.actor.name
    } else if (input.actor.kind === "SYSTEM") {
      actorRole = "SYSTEM"
      actorEmail = "system@altomatehr"
      actorName = input.actor.name ?? "System"
    } else {
      // PARTNER_API
      actorRole = "PARTNER_API"
      actorEmail = input.actor.partnerEmail ?? "partner@api"
      actorName = input.actor.integrationName
      partnerInitiated = true
    }

    await auditLogRepository.create({
      organizationId: input.organizationId,
      actorUserId,
      actorRole,
      actorEmail,
      actorName,
      action: input.action,
      status: input.status,
      summary: input.summary,
      errorReason: input.errorReason ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
      ipAddress: input.ipAddress ?? null,
      partnerInitiated,
    })
  } catch (err) {
    console.error("[audit] failed to write row:", err)
  }
}

/// Convenience wrapper for service code that has only a User id at
/// hand (most internal services don't carry the full session). Looks
/// up email/name/role once, then delegates to writeAudit. Same
/// fire-and-forget contract — never throws.
export async function writeAuditByUserId(input: {
  organizationId: string
  actorUserId: string
  action: string
  status: AuditStatus
  summary: string
  errorReason?: string | null
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown> | null
  ipAddress?: string | null
  partnerInitiated?: boolean
}): Promise<void> {
  try {
    const prisma = getPrismaClient()
    if (!prisma) return
    const user = await prisma.user.findUnique({
      where: { id: input.actorUserId },
      select: { id: true, email: true, name: true, role: true },
    })
    if (!user) {
      // Unknown actor — fall back to a system-attributed row so the
      // event still shows in the feed (better than silent miss).
      await writeAudit({
        organizationId: input.organizationId,
        actor: { kind: "SYSTEM", name: "Unknown user" },
        action: input.action,
        status: input.status,
        summary: input.summary,
        errorReason: input.errorReason,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata,
        ipAddress: input.ipAddress,
        partnerInitiated: input.partnerInitiated,
      })
      return
    }
    await writeAudit({
      organizationId: input.organizationId,
      actor: {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      action: input.action,
      status: input.status,
      summary: input.summary,
      errorReason: input.errorReason,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata,
      ipAddress: input.ipAddress,
      partnerInitiated: input.partnerInitiated,
    })
  } catch (err) {
    console.error("[audit] writeAuditByUserId failed:", err)
  }
}

/// Reader used by the admin Activity log tab.
export async function listAuditEntries(
  organizationId: string,
  filter: AuditLogFilter = {},
): Promise<{ entries: AuditLogEntry[]; nextCursor: string | null }> {
  return auditLogRepository.listForOrganization(organizationId, filter)
}

/// Daily cron: delete rows older than 7 days.
const RETENTION_DAYS = 7
export async function pruneAuditLog(): Promise<{
  deleted: number
  cutoffIso: string
}> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const { deleted } = await auditLogRepository.deleteOlderThan(cutoff)
  return { deleted, cutoffIso: cutoff.toISOString() }
}
