import "server-only"

import type { AppRole } from "@/lib/auth/types"
import { getCurrentSession } from "@/lib/auth/session"
import { auditLogRepository } from "@/modules/audit/infrastructure/audit-log.repository"
import { superadminAuditRepository } from "@/modules/audit/infrastructure/superadmin-audit.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
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
///
/// SUPERADMIN INTERCEPT — when the calling request's session belongs
/// to a Fusioneta-side support user (`session.isSuperadmin`) and the
/// target org isn't their own, the actor written to the customer's
/// OrganizationAuditLog is rewritten to `System (Support)` so the
/// customer can't tell which specific staff member touched their
/// data. A parallel row lands in SuperadminAuditLog with the REAL
/// actor for internal accountability. This intercept is transparent
/// to callers — every existing `writeAudit({ actor: {userId,...} })`
/// callsite works unchanged.
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

    // Superadmin transparency intercept. Only kicks in when:
    //   (1) the request has a session,
    //   (2) that session is flagged as a superadmin, AND
    //   (3) the action targets an org OTHER than the superadmin's
    //       own home org (so his day-to-day actions inside Fusioneta
    //       stay attributed normally).
    // When all three hold: rewrite the customer-visible actor to
    // "System (Support)" AND log the real actor into
    // SuperadminAuditLog for internal accountability.
    let superadminActor: {
      userId: string | null
      email: string
      name: string
      targetOrgId: string
    } | null = null
    try {
      const session = await getCurrentSession()
      if (
        session?.isSuperadmin &&
        session.organizationId !== input.organizationId
      ) {
        superadminActor = {
          userId: session.userId,
          email: session.email,
          name: session.name,
          targetOrgId: input.organizationId,
        }
        // Rewrite the actor written to the customer's org log.
        actorUserId = null
        actorRole = "SYSTEM"
        actorEmail = "system@altomatehr"
        actorName = "System (Support)"
      }
    } catch {
      // Session read failure (e.g. audit fired from a cron with no
      // cookie context) — fall through with the caller-supplied
      // actor. Non-fatal: the audit row still writes, just without
      // the superadmin rewrite. Very unlikely to fire for admin
      // action paths (which all have a session).
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

    // Fire the parallel superadmin trail AFTER the org row lands, so
    // an audit-repo failure doesn't leave the two logs out of sync.
    if (superadminActor) {
      try {
        // Look up the target org name for a self-contained row —
        // the internal audit page shouldn't need a JOIN to render.
        const targetOrg = await organizationRepository.getOrganizationById(
          superadminActor.targetOrgId,
        )
        await superadminAuditRepository.create({
          actorUserId: superadminActor.userId,
          actorEmail: superadminActor.email,
          actorName: superadminActor.name,
          targetOrganizationId: superadminActor.targetOrgId,
          targetOrganizationName: targetOrg?.name ?? "(unknown org)",
          action: input.action,
          summary: input.summary,
          metadata: input.metadata ?? null,
        })
      } catch (err) {
        // Never let the accountability log's failure hide the fact
        // that the customer's audit was rewritten. Log loud enough
        // for the Fusioneta staff to notice.
        console.error(
          "[audit] SUPERADMIN accountability write failed — customer log was rewritten to System but internal trail is MISSING for this row:",
          err,
        )
      }
    }
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
    const user = await organizationRepository.findUserByIdWithHash(
      input.actorUserId,
    )
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

/**
 * Build the daily-login report — a summary of every EMPLOYEE /
 * SUPERVISOR sign-in in the last N hours, grouped by user and
 * formatted for a plain-text WhatsApp / SMS message.
 *
 * Used by the `/api/cron/daily-login-report` endpoint. Cross-org
 * scan — the endpoint's caller is a bearer-authed operator, not
 * a per-org admin.
 *
 * Returns `{ message, uniqueUsers, totalSessions }`. Even when
 * zero rows match the filter, `message` is populated with a
 * "no sign-ins" line so the caller can still deliver a beat
 * (silence would be ambiguous — did the routine fail or was it
 * genuinely quiet?).
 */
export async function buildDailyLoginReport(input?: {
  lookbackHours?: number
}): Promise<{
  message: string
  uniqueUsers: number
  totalSessions: number
}> {
  const hours = input?.lookbackHours ?? 24
  const now = new Date()
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000)

  const rows = await auditLogRepository.listRecentByAction({
    action: "auth.login",
    actorRoles: ["EMPLOYEE", "SUPERVISOR"],
    since,
  })

  // Dedupe by user — one row per person with total-session count.
  type Row = (typeof rows)[number]
  const perUser = new Map<string, { latest: Row; count: number }>()
  for (const r of rows) {
    const key = r.actorUserId ?? r.actorEmail
    if (!key) continue
    const entry = perUser.get(key)
    if (entry) entry.count += 1
    else perUser.set(key, { latest: r, count: 1 })
  }

  const uniqueUsers = perUser.size
  const totalSessions = rows.length
  const rangeLabel = `${fmtMyt(since)} → ${fmtMyt(now)}`

  if (uniqueUsers === 0) {
    return {
      message: `🔒 Daily login report (${rangeLabel})\n\nNo employee or supervisor sign-ins in the last ${hours}h.`,
      uniqueUsers: 0,
      totalSessions: 0,
    }
  }

  // Supervisors first, then employees; within each group latest-first.
  const sorted = [...perUser.values()].sort((a, b) => {
    const roleA = a.latest.actorRole ?? ""
    const roleB = b.latest.actorRole ?? ""
    if (roleA !== roleB) {
      if (roleA === "SUPERVISOR") return -1
      if (roleB === "SUPERVISOR") return 1
    }
    return b.latest.createdAt.getTime() - a.latest.createdAt.getTime()
  })

  const lines = sorted.map((u) => {
    const name = u.latest.actorName || u.latest.actorEmail || "(unknown)"
    const role = u.latest.actorRole ?? ""
    const org = u.latest.organizationName
    const time = fmtMytTime(u.latest.createdAt)
    const times = u.count > 1 ? ` ×${u.count}` : ""
    return `• ${name} (${role})${times} — last ${time}${org ? ` [${org}]` : ""}`
  })

  const message = [
    `🔒 Daily login report (${rangeLabel})`,
    ``,
    `${uniqueUsers} people, ${totalSessions} sessions in the last ${hours}h.`,
    ``,
    ...lines,
  ].join("\n")

  return { message, uniqueUsers, totalSessions }
}

/// Format Date as "13 Jul 19:00" in Asia/Kuala_Lumpur.
function fmtMyt(d: Date): string {
  return new Intl.DateTimeFormat("en-MY", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d)
}

/// Format Date as "19:00" in Asia/Kuala_Lumpur.
function fmtMytTime(d: Date): string {
  return new Intl.DateTimeFormat("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d)
}
