import Link from "next/link"
import { ClipboardCheck } from "lucide-react"

import { Button } from "@/components/attendance/ui/button"
import { Card } from "@/components/attendance/ui/card"
import { DailyActivityTable } from "@/components/attendance/daily-activity-table"
import { ProjectSwitcher } from "@/components/attendance/project-switcher"
import { type TableFilterValue } from "@/components/attendance/table-filter-bar"
import { ReportExportButtons } from "@/components/attendance/report-export-buttons"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

type SearchParams = Record<string, string | string[] | undefined>

function readParam(params: SearchParams, key: string): string | null {
  const v = params[key]
  return typeof v === "string" && v.trim() ? v : null
}

// The DailyActivityTable filter bar reads/writes `teamProject`, `teamTeam`,
// `teamQ` URL params (prefix "team"), same convention as the admin table.
function readFilter(params: SearchParams): TableFilterValue {
  return {
    projectId: readParam(params, "teamProject"),
    teamId: readParam(params, "teamTeam"),
    q: readParam(params, "teamQ"),
  }
}

export default async function TeamOverviewPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>
}) {
  const session = await requirePortalSession("SUPERVISOR")
  const orgId = resolveActiveOrgId(session) ?? null
  const params = (await searchParams) ?? {}
  const filter = readFilter(params)

  const [overview, activity, tz] = await Promise.all([
    supervisorAttendanceService.getTeamOverview(session.userId),
    supervisorAttendanceService.getTeamDailyActivity(session.userId, orgId, filter),
    attendanceRepository.getOrgTimezone(orgId),
  ])

  const attendanceRate =
    overview.teamSize > 0
      ? Math.round((overview.presentToday / overview.teamSize) * 100)
      : 0

  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const year = new Date().getUTCFullYear()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Real-time
          </p>
          <h2 className="font-headline mt-0.5 text-xl font-bold text-foreground">
            {session.organizationName ?? "Your team"}
          </h2>
        </div>
        <ReportExportButtons from={initialFrom} to={initialTo} year={year} />
      </div>

      {/* Two supervisor-only glances that the table below doesn't cover.
          The per-status counts (in office / late / on leave / …) live in
          the table's filter pills, so we don't duplicate them as cards. */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="flex flex-col rounded-2xl bg-secondary/60 p-4">
          <ClipboardCheck className="h-5 w-5 text-primary" />
          <p className="font-headline mt-1 text-2xl font-extrabold text-primary">
            {String(overview.pendingApprovals).padStart(2, "0")}
          </p>
          <p className="mb-3 text-[11px] font-semibold text-muted-foreground">
            Pending approvals
          </p>
          <Link href="/employee/attendance/approvals" className="mt-auto">
            <Button size="sm" className="w-full text-xs">
              Review all
            </Button>
          </Link>
        </Card>

        <Card className="rounded-2xl p-4">
          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">
            Attendance rate today
          </p>
          <p className="font-headline text-3xl font-extrabold text-foreground">
            {attendanceRate}%
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {overview.presentToday} of {overview.teamSize} present
          </p>
        </Card>
      </div>

      {/* ◄ ► project switcher — simpler than a dropdown on mobile, and
          the table's own project dropdown is hidden below to match. */}
      <ProjectSwitcher
        prefix="team"
        projects={activity.projects}
        value={filter.projectId}
      />

      <DailyActivityTable
        rows={activity.rows}
        timezone={tz}
        title="Your team today"
        filterBar={{
          prefix: "team",
          projects: activity.projects,
          teams: activity.teams,
          value: filter,
          hideProject: true,
        }}
        employeeHrefBase="/employee/attendance/team"
      />
    </div>
  )
}
