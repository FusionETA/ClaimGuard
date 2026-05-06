import { redirect } from "next/navigation"
import Link from "next/link"
import type { Route } from "next"
import { ChevronRight, Download, FolderKanban, Users, User } from "lucide-react"

import { BreakdownMonthPicker } from "@/components/admin/breakdown-month-picker"
import { Card, CardContent } from "@/components/ui/card"
import { getCurrentSession } from "@/lib/auth/session"
import { cn, formatCurrency, formatShortDate } from "@/lib/utils"
import {
  buildMonthOptions,
  getMemberClaimsBreakdown,
  getMembersBreakdown,
  getProjectsBreakdown,
  getTeamsBreakdown,
} from "@/modules/claims/application/services/claims-breakdown.service"

type SearchParams = {
  month?: string
  project?: string
  team?: string
  member?: string
}

export default async function AdminClaimsBreakdownPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  const params = await searchParams
  const monthKey = params.month
  const monthOptions = buildMonthOptions(12)

  // Determine which level to render based on which params are set.
  // Drill order: project → team → member → claim list. Anything below
  // the "deepest set" param is ignored.
  const level: "projects" | "teams" | "members" | "claims" = params.member
    ? "claims"
    : params.team
      ? "members"
      : params.project
        ? "teams"
        : "projects"

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Breadcrumb level={level} params={params} monthKey={monthKey} />
        <div className="flex items-center gap-2">
          <BreakdownMonthPicker
            options={monthOptions}
            activeKey={monthKey ?? monthOptions[0]?.key ?? ""}
            // Preserve drill-down params when changing month so the
            // selected project/team/member stays in scope.
            carryParams={{
              project: params.project,
              team: params.team,
              member: params.member,
            }}
          />
          <ExportButton
            level={level}
            monthKey={monthKey ?? monthOptions[0]?.key ?? ""}
            params={params}
          />
        </div>
      </div>

      {level === "projects" ? (
        <ProjectsLevel monthKey={monthKey} />
      ) : null}
      {level === "teams" ? (
        <TeamsLevel projectId={params.project!} monthKey={monthKey} />
      ) : null}
      {level === "members" ? (
        <MembersLevel
          projectId={params.project!}
          teamId={params.team!}
          monthKey={monthKey}
        />
      ) : null}
      {level === "claims" ? (
        <ClaimsLevel
          projectId={params.project!}
          employeeId={params.member!}
          monthKey={monthKey}
        />
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Breadcrumb
// ----------------------------------------------------------------------------

function Breadcrumb({
  level,
  params,
  monthKey,
}: {
  level: "projects" | "teams" | "members" | "claims"
  params: SearchParams
  monthKey?: string
}) {
  // We don't preload names server-side here for breadcrumb segments —
  // the level component itself shows the heading with the project/team/
  // member name. Breadcrumb stays compact: "By project / Project / Team /
  // Member". Each crumb links back to the correct ancestor level with
  // the month preserved.
  const crumbs: { label: string; href: Route | null }[] = [
    {
      label: "Reports",
      href: level === "projects" ? null : buildHref({ month: monthKey }),
    },
  ]
  if (level === "teams" || level === "members" || level === "claims") {
    crumbs.push({
      label: "Project",
      href:
        level === "teams"
          ? null
          : buildHref({ month: monthKey, project: params.project }),
    })
  }
  if (level === "members" || level === "claims") {
    crumbs.push({
      label: "Team",
      href:
        level === "members"
          ? null
          : buildHref({
              month: monthKey,
              project: params.project,
              team: params.team,
            }),
    })
  }
  if (level === "claims") {
    crumbs.push({ label: "Member", href: null })
  }

  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm">
      {crumbs.map((crumb, i) => (
        <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
          {crumb.href ? (
            <Link
              href={crumb.href}
              className="font-semibold text-muted-foreground hover:text-foreground"
            >
              {crumb.label}
            </Link>
          ) : (
            <span className="font-semibold text-foreground">{crumb.label}</span>
          )}
          {i < crumbs.length - 1 ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          ) : null}
        </span>
      ))}
    </nav>
  )
}

function buildHref(params: {
  month?: string
  project?: string
  team?: string
  member?: string
}): Route {
  const qs = new URLSearchParams()
  if (params.month) qs.set("month", params.month)
  if (params.project) qs.set("project", params.project)
  if (params.team) qs.set("team", params.team)
  if (params.member) qs.set("member", params.member)
  const tail = qs.toString()
  // Cast through unknown because the dynamic query string isn't statically
  // analysable by Next's typed-routes generator. The base path is a real
  // route; the query string is data we tack on at runtime.
  return (
    tail ? `/admin/claims/breakdown?${tail}` : "/admin/claims/breakdown"
  ) as Route
}

// ----------------------------------------------------------------------------
// Levels
// ----------------------------------------------------------------------------

async function ProjectsLevel({ monthKey }: { monthKey?: string }) {
  const data = await getProjectsBreakdown(monthKey)
  if (!data) return <EmptyState message="Couldn't load breakdown." />

  return (
    <div>
      <SectionHeader
        icon={<FolderKanban className="h-5 w-5" />}
        title="Projects"
        subtitle={`${data.projects.length} project${data.projects.length === 1 ? "" : "s"} with claims this month.`}
      />
      {data.projects.length === 0 ? (
        <EmptyState message="No claims filed against any project this month." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.projects.map((project) => (
            <BreakdownCard
              key={project.projectId}
              href={buildHref({ month: data.monthKey, project: project.projectId })}
              title={project.projectName}
              totalAmount={project.totalAmount}
              count={project.count}
              statusMix={project.statusMix}
            />
          ))}
        </div>
      )}
    </div>
  )
}

async function TeamsLevel({
  projectId,
  monthKey,
}: {
  projectId: string
  monthKey?: string
}) {
  const data = await getTeamsBreakdown({ projectId, monthKey })
  if (!data) return <EmptyState message="Couldn't load breakdown." />

  return (
    <div>
      <SectionHeader
        icon={<Users className="h-5 w-5" />}
        title="Teams"
        subtitle={`${data.teams.length} team${data.teams.length === 1 ? "" : "s"} on this project.`}
      />
      {data.teams.length === 0 ? (
        <EmptyState message="This project has no teams yet, or no claims this month." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.teams.map((team) => (
            <BreakdownCard
              key={team.teamId}
              href={buildHref({
                month: data.monthKey,
                project: projectId,
                team: team.teamId,
              })}
              title={team.teamName}
              totalAmount={team.totalAmount}
              count={team.count}
              statusMix={team.statusMix}
            />
          ))}
        </div>
      )}
    </div>
  )
}

async function MembersLevel({
  projectId,
  teamId,
  monthKey,
}: {
  projectId: string
  teamId: string
  monthKey?: string
}) {
  const data = await getMembersBreakdown({ projectId, teamId, monthKey })
  if (!data) return <EmptyState message="Couldn't load breakdown." />

  return (
    <div>
      <SectionHeader
        icon={<User className="h-5 w-5" />}
        title="Members"
        subtitle={`${data.members.length} team member${data.members.length === 1 ? "" : "s"}.`}
      />
      {data.members.length === 0 ? (
        <EmptyState message="This team has no members yet." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.members.map((member) => (
            <BreakdownCard
              key={member.employeeId}
              href={buildHref({
                month: data.monthKey,
                project: projectId,
                team: teamId,
                member: member.employeeId,
              })}
              title={member.employeeName}
              subtitle={member.employeeEmail}
              totalAmount={member.totalAmount}
              count={member.count}
              statusMix={member.statusMix}
            />
          ))}
        </div>
      )}
    </div>
  )
}

async function ClaimsLevel({
  projectId,
  employeeId,
  monthKey,
}: {
  projectId: string
  employeeId: string
  monthKey?: string
}) {
  const data = await getMemberClaimsBreakdown({ projectId, employeeId, monthKey })
  if (!data) return <EmptyState message="Couldn't load breakdown." />

  const totalAmount = data.claims.reduce((sum, c) => sum + c.amount, 0)

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={<User className="h-5 w-5" />}
        title="Claims"
        subtitle={`${data.claims.length} claim${data.claims.length === 1 ? "" : "s"} totalling ${formatCurrency(totalAmount)}.`}
      />
      {data.claims.length === 0 ? (
        <EmptyState message="This member hasn't filed any claims for this project this month." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-surface-low text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.claims.map((claim) => (
                  <tr
                    key={claim.id}
                    className="border-t border-border/50 hover:bg-surface-low/60"
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      {claim.title}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatShortDate(claim.spentAt)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {claim.chartOfAccount
                        ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {formatCurrency(claim.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={claim.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Reusable bits
// ----------------------------------------------------------------------------

function SectionHeader({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
}) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <span className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">{icon}</span>
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

function BreakdownCard({
  href,
  title,
  subtitle,
  totalAmount,
  count,
  statusMix,
}: {
  href: Route
  title: string
  subtitle?: string
  totalAmount: number
  count: number
  statusMix: Record<string, number>
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/94 p-5 shadow-ambient transition-all hover:border-primary/40 hover:shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-foreground">{title}</p>
          {subtitle ? (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>

      <div>
        <p className="text-2xl font-bold tabular-nums">
          {formatCurrency(totalAmount)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {count} claim{count === 1 ? "" : "s"}
        </p>
      </div>

      <StatusMixStrip statusMix={statusMix} count={count} />
    </Link>
  )
}

function StatusMixStrip({
  statusMix,
  count,
}: {
  statusMix: Record<string, number>
  count: number
}) {
  if (count === 0) {
    return (
      <p className="text-xs italic text-muted-foreground">No claims yet</p>
    )
  }
  const order: Array<keyof typeof STATUS_LABEL> = [
    "PENDING",
    "SUBMITTED",
    "APPROVED",
    "PAID",
    "REJECTED",
  ]
  const present = order.filter((s) => (statusMix[s] ?? 0) > 0)
  return (
    <div className="flex flex-wrap gap-1.5">
      {present.map((status) => (
        <span
          key={status}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            STATUS_BG[status],
          )}
        >
          {statusMix[status]} {STATUS_LABEL[status]}
        </span>
      ))}
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "pending",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  PAID: "paid",
  REJECTED: "rejected",
}

const STATUS_BG: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-900",
  SUBMITTED: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-900",
  PAID: "bg-emerald-200 text-emerald-950",
  REJECTED: "bg-rose-100 text-rose-900",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        STATUS_BG[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

/**
 * Simple anchor that downloads the .xlsx file matching the current view.
 * Server-side route enforces auth + scope, so a plain GET is enough — no
 * fetch, no progress UI, browser handles the download dialog.
 */
function ExportButton({
  level,
  monthKey,
  params,
}: {
  level: "projects" | "teams" | "members" | "claims"
  monthKey: string
  params: SearchParams
}) {
  const qs = new URLSearchParams()
  qs.set("level", level)
  qs.set("month", monthKey)
  if (params.project) qs.set("project", params.project)
  if (params.team) qs.set("team", params.team)
  if (params.member) qs.set("member", params.member)
  const href =
    `/api/admin/claims/breakdown/export?${qs.toString()}` as unknown as Route

  // The button label tells the admin which scope is about to be exported,
  // so they don't have to guess what's in the file before opening it.
  const label =
    level === "projects"
      ? "Export projects"
      : level === "teams"
        ? "Export teams"
        : level === "members"
          ? "Export members"
          : "Export claims"

  return (
    <a
      href={href}
      // Triggering a download with a normal anchor is the most resilient
      // approach — works without JS, supports browser-side progress and
      // the browser's own filename handling.
      className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-surface-low"
    >
      <Download className="h-4 w-4" />
      {label}
    </a>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-10 text-center">
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  )
}
