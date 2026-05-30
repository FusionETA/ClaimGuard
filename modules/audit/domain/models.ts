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
  /// Prefix block-list — anything starting with one of these is
  /// dropped at the DB level. Used by the admin Activity log page
  /// to hide operational module events (claims / attendance / leave
  /// / payroll) so the feed reads as a "who changed the org config"
  /// audit rather than a stream of every approval click. Note the
  /// events are still WRITTEN — they're just filtered out of this
  /// reader.
  excludeActionPrefixes?: string[]
  status?: AuditStatus
  actorUserId?: string
  /// Date range — INCLUSIVE start, EXCLUSIVE end (ISO).
  fromIso?: string
  toIso?: string
  limit?: number
  cursor?: string // opaque — the last `id` from the previous page
}

/**
 * Canonical "operational" prefix list — the modules whose per-module
 * page already shows its own audit trail (Claims queue, Attendance
 * approvals, Leave approvals, Payroll runs) and so don't belong on
 * the org-wide Activity log.
 *
 * Centralised so the page can import it without re-stating the list
 * inline, and any future addition stays in one place.
 *
 * Exception: events under `payroll.settings.` and
 * `payroll.company-info.` ARE config changes (not run approvals), so
 * the page-level allow-list re-adds them explicitly. See the
 * `excludeActionPrefixes` filter call in the page.
 */
export const OPERATIONAL_ACTION_PREFIXES = [
  "claim.",
  "attendance.",
  "leave.",
  "payroll.",
] as const

/**
 * Human-readable label for each audit action. Maps the underlying
 * `module.verb` code (which we keep on the row for forensics +
 * grouping) to a short sentence the admin can scan. Add entries here
 * when a new action is wired up.
 *
 * Format conventions:
 *   - Past-tense verbs ("created", "updated") match how an admin
 *     describes what they did after the fact.
 *   - No trailing punctuation — the table cell renders it as a label,
 *     not a sentence.
 *   - Don't repeat the module — "Policy created" not "Created policy
 *     in policies module".
 *
 * `humanizeAuditAction()` looks up by exact match first, then falls
 * back to a generic prettifier. Missing entries still render readably,
 * just less polished.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  // Admins & auth
  "admin.add": "Admin added",
  "admin.remove": "Admin removed",
  "auth.password.change": "Password changed",
  "auth.password.reset": "Password reset via email",
  // API tokens
  "api.token.create": "API token created",
  "api.token.enable": "API token re-enabled",
  "api.token.revoke": "API token revoked",
  "api.token.delete": "API token deleted",
  "api.token.scopes.update": "API token scopes updated",
  // Xero
  "xero.connect": "Xero connected",
  "xero.disconnect": "Xero disconnected",
  "xero.tenant.select": "Xero tenant selected",
  // Employees
  "employee.create": "Employee added",
  "employee.archive": "Employee archived",
  "employee.restore": "Employee restored",
  // Org-level settings
  "settings.org.update": "Organisation details updated",
  "settings.claim-run.update": "Claim cutoff updated",
  "settings.currency.update": "Currency settings updated",
  "settings.mileage.update": "Mileage defaults updated",
  "settings.working-hours.update": "Working hours updated",
  "settings.timezone.update": "Timezone updated",
  "settings.ot.enable": "Overtime enabled",
  "settings.ot.disable": "Overtime disabled",
  "settings.supervisor-reports.update": "Supervisor reports updated",
  "settings.geofence-radius.update": "Geofence radius updated",
  // Chart of accounts
  "coa.create": "Custom account created",
  "coa.delete": "Custom account deleted",
  "coa.selectable.update": "Selectable accounts updated",
  "coa.bank.update": "Bank accounts updated",
  "coa.mileage.update": "Mileage accounts updated",
  "coa.limit.update": "Account limit updated",
  // Policies
  "policy.create": "Policy created",
  "policy.update": "Policy updated",
  "policy.set-default": "Default policy changed",
  "policy.archive": "Policy archived",
  // Teams
  "team.create": "Team created",
  "team.update": "Team updated",
  "team.delete": "Team deleted",
  // Projects
  "project.create": "Project created",
  "project.update": "Project updated",
  "project.delete": "Project deleted",
  // Payroll config (NOT runs — those stay on the run detail page)
  "payroll.settings.update": "Payroll settings updated",
  "payroll.company-info.update": "Payroll company info updated",
  // Leave types
  "leave.type.create": "Leave type created",
  "leave.type.update": "Leave type updated",
  "leave.type.archive": "Leave type archived",
  "leave.type.unarchive": "Leave type restored",
}

/**
 * Render a friendly label for an audit action code. Falls back to a
 * generic title-cased version when the action isn't in the map (so a
 * brand-new event added without updating the map still reads
 * reasonably — `foo.bar.update` → "Foo bar update").
 */
export function humanizeAuditAction(action: string): string {
  if (action in AUDIT_ACTION_LABELS) return AUDIT_ACTION_LABELS[action]
  const words = action.split(".").join(" ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
