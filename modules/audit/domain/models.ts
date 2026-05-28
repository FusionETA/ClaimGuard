/**
 * Per-organization audit / activity log domain types.
 *
 * `action` is namespaced "module.verb" so the UI can group + filter.
 * Keep the list curated — add only when the event is genuinely
 * interesting to an admin reading the activity feed (skip every form
 * keystroke, every page view, every cache miss).
 */

export type AuditStatus = "SUCCESS" | "FAILED"

export type AuditActorRole =
  | "EMPLOYEE"
  | "SUPERVISOR"
  | "ADMIN"
  | "OWNER"
  | "SYSTEM"
  | "PARTNER_API"

/// View-model surfaced to the admin Activity log tab.
export type AuditLogEntry = {
  id: string
  organizationId: string
  actorUserId: string | null
  actorRole: AuditActorRole | null
  actorEmail: string
  actorName: string
  action: string
  status: AuditStatus
  summary: string
  errorReason: string | null
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown> | null
  ipAddress: string | null
  partnerInitiated: boolean
  createdAt: string // ISO
}

/// Filter shape used by the Activity log tab.
export type AuditLogFilter = {
  /// "claim.approve" exact match, or just "claim" prefix.
  actionPrefix?: string
  status?: AuditStatus
  actorUserId?: string
  /// Date range — INCLUSIVE start, EXCLUSIVE end (ISO).
  fromIso?: string
  toIso?: string
  limit?: number
  cursor?: string // opaque — the last `id` from the previous page
}
