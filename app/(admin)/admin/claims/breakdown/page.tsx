import { redirect } from "next/navigation"
import type { Route } from "next"
import { Download } from "lucide-react"

import { ClaimsReportFilters } from "@/components/admin/claims-report-filters"
import { ClaimsReportPagination } from "@/components/admin/claims-report-pagination"
import { Card, CardContent } from "@/components/ui/card"
import { getCurrentSession } from "@/lib/auth/session"
import { cn, formatCurrency, formatShortDate } from "@/lib/utils"
import { getClaimsReportPageData } from "@/modules/claims/application/services/claims-breakdown.service"

/**
 * /admin/claims/breakdown — admin "Reports" page.
 *
 * Replaces the previous project → team → member → claims drill-down
 * with a single flat paginated table. URL search-params drive every
 * filter; the page renders 20 claims per page by default and reads
 * `from` / `to` / `projects` / `teams` / `members` / `page` from the
 * URL.
 *
 * The export link reuses the exact same query-string, so admins can
 * download whatever they're currently looking at.
 */

type SearchParams = {
  from?: string
  to?: string
  projects?: string
  teams?: string
  members?: string
  page?: string
}

function parseCsvIds(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export default async function AdminClaimsReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  const params = await searchParams
  const projectIds = parseCsvIds(params.projects)
  const teamIds = parseCsvIds(params.teams)
  const memberIds = parseCsvIds(params.members)
  const page = Math.max(1, Number(params.page) || 1)

  const data = await getClaimsReportPageData({
    filters: {
      from: params.from ?? null,
      to: params.to ?? null,
      projects: projectIds,
      teams: teamIds,
      members: memberIds,
    },
    page,
  })

  if (!data) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load report data.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Build the export href using the exact same params the page
  // received, so the admin downloads what they're looking at.
  const exportParams = new URLSearchParams()
  exportParams.set("from", data.resolvedFrom)
  exportParams.set("to", data.resolvedTo)
  if (projectIds.length > 0) exportParams.set("projects", projectIds.join(","))
  if (teamIds.length > 0) exportParams.set("teams", teamIds.join(","))
  if (memberIds.length > 0) exportParams.set("members", memberIds.join(","))
  const exportHref =
    (`/api/admin/claims/breakdown/export?${exportParams.toString()}` as unknown) as Route

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold text-foreground">Reports</h2>
          <p className="text-xs text-muted-foreground">
            Flat list of claims for the selected period and scope. Filter by
            project, team, or member; export the matching set as XLSX.
          </p>
        </div>
        <a
          href={exportHref}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-surface-low"
        >
          <Download className="h-4 w-4" />
          Export claims
        </a>
      </div>

      <ClaimsReportFilters
        initialFrom={data.resolvedFrom}
        initialTo={data.resolvedTo}
        initialProjectIds={projectIds}
        initialTeamIds={teamIds}
        initialMemberIds={memberIds}
        projectOptions={data.filterOptions.projects.map((p) => ({
          id: p.id,
          name: p.name,
        }))}
        teamOptions={data.filterOptions.teams.map((t) => ({
          id: t.id,
          name: t.name,
          // parentId enables the LIVE client-side cascade — Teams
          // dropdown narrows to picked Projects immediately, no
          // server round-trip required.
          parentId: t.projectId,
          // Add project name as secondary text so admins distinguish
          // same-named teams across projects (rare but possible).
          secondary:
            data.filterOptions.projects.find((p) => p.id === t.projectId)?.name,
        }))}
        memberOptions={data.filterOptions.members.map((m) => ({
          id: m.id,
          name: m.name,
          // parentIds = the teams this member belongs to. Drives the
          // live cascade for the Members dropdown.
          parentIds: m.teamIds,
          secondary: m.email,
        }))}
      />

      {/* Summary header — three numbers above the table so the admin
          knows how big the filtered set is before scrolling. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryStat label="Date range" value={`${data.resolvedFrom} → ${data.resolvedTo}`} />
        <SummaryStat label="Matching claims" value={data.total.toLocaleString()} />
        <SummaryStat label="Total amount" value={formatCurrency(data.totalAmount)} />
      </div>

      {/* The table itself. Renders a tasteful empty state when no
          rows match the current filter so admins don't see a bare
          card with just headers. */}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-surface-low text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Project</th>
                <th className="px-4 py-3">Claim</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Spent</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No claims match the current filters.
                  </td>
                </tr>
              ) : (
                data.rows.map((claim) => (
                  <tr
                    key={claim.id}
                    className="border-t border-border/50 hover:bg-surface-low/60"
                  >
                    <td className="px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {claim.employee?.name ?? "—"}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {claim.employee?.email ?? ""}
                        </p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {claim.employee?.project ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{claim.title}</p>
                      <p className="text-xs text-muted-foreground">{claim.claimNumber}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {claim.chartOfAccount
                        ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatShortDate(claim.spentAt)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {formatCurrency(claim.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={claim.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {data.total > data.pageSize ? (
        <ClaimsReportPagination
          currentPage={data.page}
          pageSize={data.pageSize}
          totalItems={data.total}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small subcomponents
// ---------------------------------------------------------------------------

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/94 p-4 shadow-ambient">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "submitted",
  PENDING: "pending",
  APPROVED: "approved",
  PAID: "paid",
  REJECTED: "rejected",
  REVIEWED: "reviewed",
  SETTLED: "settled",
}

const STATUS_BG: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-900",
  SUBMITTED: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-900",
  PAID: "bg-emerald-200 text-emerald-950",
  REJECTED: "bg-rose-100 text-rose-900",
  REVIEWED: "bg-sky-100 text-sky-900",
  SETTLED: "bg-emerald-200 text-emerald-950",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        STATUS_BG[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {STATUS_LABEL[status] ?? status.toLowerCase()}
    </span>
  )
}
