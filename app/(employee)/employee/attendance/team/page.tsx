import Link from "next/link"
import { ClipboardCheck, Clock, UmbrellaOff, Users } from "lucide-react"

import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { DailyActivityTable } from "@/components/attendance/daily-activity-table"
import { type TableFilterValue } from "@/components/attendance/table-filter-bar"
import { ReportExportButtons } from "@/components/attendance/report-export-buttons"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { cn } from "@/lib/utils"

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
    <div className="space-y-5">
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

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "In Office", value: overview.presentToday, icon: Users, color: "text-success" },
          { label: "Late", value: overview.lateToday, icon: Clock, color: "text-tertiary" },
          {
            label: "On Leave",
            value: overview.onLeaveToday,
            icon: UmbrellaOff,
            color: "text-muted-foreground",
          },
        ].map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.label} className="rounded-2xl p-3 text-center">
              <Icon className={cn("mx-auto h-5 w-5", s.color)} />
              <p className="font-headline mt-1 text-2xl font-extrabold text-foreground">
                {s.value}
              </p>
              <p className="text-[10px] font-semibold text-muted-foreground">{s.label}</p>
            </Card>
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="rounded-2xl bg-secondary/60 p-4">
          <ClipboardCheck className="h-5 w-5 text-primary" />
          <p className="font-headline mt-1 text-2xl font-extrabold text-primary">
            {String(overview.pendingApprovals).padStart(2, "0")}
          </p>
          <p className="mb-3 text-[11px] font-semibold text-muted-foreground">
            Pending Approvals
          </p>
          <Link href="/employee/attendance/approvals">
            <Button size="sm" className="w-full text-xs">
              Review All
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

      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <p className="mb-3 text-sm font-bold text-foreground">Team directory</p>
          <DailyActivityTable
            rows={activity.rows}
            timezone={tz}
            filterBar={{
              prefix: "team",
              projects: activity.projects,
              teams: activity.teams,
              value: filter,
            }}
            employeeHrefBase="/employee/attendance/team"
          />
        </CardContent>
      </Card>
    </div>
  )
}
