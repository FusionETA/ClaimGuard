import Link from "next/link"
import { redirect } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { listAuditEntries } from "@/modules/audit/application/services/audit-log.service"
import {
  humanizeAuditAction,
  OPERATIONAL_ACTION_PREFIXES,
} from "@/modules/audit/domain/models"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

const PAGE_SIZE = 15

/**
 * /admin/audit — per-organization Activity log.
 *
 * Shows config-changing audit rows for the active org, newest first,
 * 15 per page. Retention is 7 days enforced by the daily prune cron
 * at /api/cron/audit-prune.
 *
 * Pagination is cursor-based on the repo: pass the last entry's `id`
 * back as `?cursor=...` to get the next 15 older rows. We don't
 * support jumping to an arbitrary page because cursor pagination
 * over `(createdAt DESC, id DESC)` makes that expensive — instead
 * we offer "Older →" and a "← Back to latest" reset link.
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  await requireAdminModule("audit_log")
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) redirect("/admin")

  // Opaque cursor — last entry id from the previous page. Empty
  // string / missing = first page (latest events).
  const sp = await searchParams
  const cursor = typeof sp.cursor === "string" ? sp.cursor : undefined

  // Operational events (claim / attendance / leave / payroll
  // approvals etc.) already have their own per-module log on each
  // module's page, so we hide them here. The page focuses on org-
  // governance: who changed settings, admin roster, API tokens,
  // OAuth grants, password resets, etc. Operational events are still
  // WRITTEN to OrganizationAuditLog — they just don't show up in this
  // view.
  const { entries, nextCursor } = await listAuditEntries(organizationId, {
    limit: PAGE_SIZE,
    cursor,
    excludeActionPrefixes: [...OPERATIONAL_ACTION_PREFIXES],
  })
  const onFirstPage = !cursor

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-headline font-extrabold text-foreground">
          Activity log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who changed the org configuration — admin roster, settings,
          API tokens, OAuth grants, password resets. Kept for 7 days.
          Failed attempts are flagged so you can spot misuse early.
          Module-level activity (claim, attendance, leave, payroll
          approvals) lives on each module&apos;s own page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {onFirstPage
              ? `Latest ${entries.length} event${entries.length === 1 ? "" : "s"}`
              : `Older events (${entries.length})`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              No configuration changes recorded yet. Adding/removing
              admins, editing settings, minting API tokens, or
              connecting Xero will appear here as they happen.
            </p>
          ) : (
            <>
              {/* Mobile: stacked cards */}
              <div className="space-y-2 p-4 md:hidden">
                {entries.map((e) => (
                  <div
                    key={e.id}
                    className="rounded-2xl border border-border/60 bg-card/40 p-3 space-y-2 backdrop-blur-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-foreground">
                          {e.summary}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {e.actorName}
                          {e.partnerInitiated ? " · via partner API" : ""}
                        </p>
                      </div>
                      <Badge
                        variant={e.status === "SUCCESS" ? "outline" : "rejected"}
                      >
                        {e.status}
                      </Badge>
                    </div>
                    {e.errorReason ? (
                      <p className="text-xs text-destructive">
                        {e.errorReason}
                      </p>
                    ) : null}
                    <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                      <span title={e.action /* raw code for forensics */}>
                        {humanizeAuditAction(e.action)}
                      </span>
                      <time
                        dateTime={e.createdAt}
                        className="shrink-0"
                        title={new Date(e.createdAt).toLocaleString()}
                      >
                        {formatRelative(e.createdAt)}
                      </time>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead className="border-b border-border/60 bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-semibold">When</th>
                      <th className="px-4 py-2 font-semibold">Actor</th>
                      <th className="px-4 py-2 font-semibold">Action</th>
                      <th className="px-4 py-2 font-semibold">Summary</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr
                        key={e.id}
                        className="border-t border-border/40 align-top"
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          <time
                            dateTime={e.createdAt}
                            title={new Date(e.createdAt).toLocaleString()}
                          >
                            {formatRelative(e.createdAt)}
                          </time>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">
                            {e.actorName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {e.actorEmail}
                            {e.partnerInitiated ? " · partner API" : ""}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-foreground">
                            {humanizeAuditAction(e.action)}
                          </p>
                          {/* Raw module.verb code, surfaced small +
                              monospaced so an auditor / Zi Rong can
                              still grep by it. Tooltip keeps long
                              codes readable without bloating the
                              column. */}
                          <p
                            className="mt-0.5 font-mono text-[10px] text-muted-foreground/70"
                            title={e.action}
                          >
                            {e.action}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-foreground">{e.summary}</p>
                          {e.errorReason ? (
                            <p className="mt-1 text-xs text-destructive">
                              {e.errorReason}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              e.status === "SUCCESS" ? "outline" : "rejected"
                            }
                          >
                            {e.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Cursor-based pagination footer. Hidden when neither
              direction is available (everything fits on one page). */}
          {(nextCursor || !onFirstPage) && entries.length > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/40 px-4 py-3">
              {onFirstPage ? (
                <span className="text-xs text-muted-foreground">
                  Showing latest {entries.length}.
                </span>
              ) : (
                <Link
                  href="/admin/audit"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  ← Back to latest
                </Link>
              )}
              {nextCursor ? (
                <Link
                  href={`/admin/audit?cursor=${encodeURIComponent(nextCursor)}`}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Older →
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Reached the end of the 7-day window.
                </span>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

/// "5m ago", "2h ago", "Yesterday at 14:32", etc. Server-side rendered
/// so it shows in the user's locale and timezone via toLocaleString
/// on the date attribute (the static text is server time). Keep simple
/// for v1 — a client-side relative-time component can swap in later.
function formatRelative(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffSec = Math.max(0, Math.round((now - then) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}
