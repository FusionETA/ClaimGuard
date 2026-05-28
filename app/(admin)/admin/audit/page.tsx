import { redirect } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { listAuditEntries } from "@/modules/audit/application/services/audit-log.service"

const PAGE_SIZE = 100

/**
 * /admin/audit — per-organization Activity log.
 *
 * Shows the last ~7 days of audit rows for the active org, newest first.
 * Retention is enforced by the daily prune cron at
 * /api/cron/audit-prune.
 */
export default async function AdminAuditPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) redirect("/admin")

  const { entries } = await listAuditEntries(organizationId, {
    limit: PAGE_SIZE,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-headline font-extrabold text-foreground">
          Activity log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent activity in this organization — kept for 7 days. Failed
          attempts are flagged so you can spot misuse early.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Last {Math.min(PAGE_SIZE, entries.length)} event
            {entries.length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              No activity recorded yet. Anything an admin / supervisor /
              partner does — claim reviews, admin invites, etc. — will
              appear here.
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
                      <span className="font-mono">{e.action}</span>
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
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {e.action}
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
