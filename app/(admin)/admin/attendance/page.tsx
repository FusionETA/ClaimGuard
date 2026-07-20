import { Suspense } from "react"
import {
  Clock,
  UmbrellaOff,
  UserMinus,
  type LucideIcon,
} from "lucide-react"

import { AdminOverviewTabs } from "@/components/attendance/admin-overview-tabs"
import { DailyActivityTable } from "@/components/attendance/daily-activity-table"
import { OffSiteLogCard } from "@/components/attendance/off-site-log-card"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type { RollCallPerson } from "@/modules/attendance/domain/models"
import {
  requireAdminModule,
} from "@/modules/organization/application/services/admin-access.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

import { AnalyticsTab } from "./analytics-tab"
import { PerformanceTab } from "./performance-tab"
import { HistoryTab } from "./history-tab"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

function readFilter(
  params: Record<string, string | string[] | undefined>,
  prefix: string,
): TableFilterValue {
  return {
    projectId: readParam(params, `${prefix}Project`),
    teamId: readParam(params, `${prefix}Team`),
    q: readParam(params, `${prefix}Q`),
  }
}

async function getOrgSupervisorSettings(
  orgId: string | null,
): Promise<{ enabled: boolean; slaMinutes: number }> {
  if (!orgId) return { enabled: true, slaMinutes: 60 }
  const org = await organizationRepository.getOrganizationById(orgId)
  return {
    enabled: org?.supervisorReportEnabled ?? true,
    slaMinutes: org?.supervisorSlaMinutes ?? 60,
  }
}

function TabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-32 w-full animate-pulse rounded-2xl bg-muted" />
      <div className="h-64 w-full animate-pulse rounded-2xl bg-muted" />
    </div>
  )
}

export default async function AdminAttendancePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requirePortalSession("ADMIN")
  await requireAdminModule("attendance")
  const orgId = resolveActiveOrgId(session) ?? null
  const params = (await searchParams) ?? {}

  const daFilter = readFilter(params, "da")
  const rcFilter = readFilter(params, "rc")
  const hsFilter = readFilter(params, "hs")
  const auFilter = readFilter(params, "au")
  const prFilter = readFilter(params, "pr")
  const supFilter = readFilter(params, "sup")
  const osFilter = readFilter(params, "os")

  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()

  // Only fetch what the Today tab needs + shared filter data
  const [
    rollCall,
    dailyActivity,
    offSiteRows,
    projects,
    teams,
    timezone,
    supervisorSettings,
  ] = await Promise.all([
    adminAttendanceService.getTodayRollCall(
      orgId,
      rcFilter.projectId,
      rcFilter.teamId,
      rcFilter.q,
    ),
    adminAttendanceService.getDailyActivity(
      orgId,
      daFilter.projectId,
      daFilter.teamId,
      daFilter.q,
    ),
    adminAttendanceService.getOffSiteClockIns(
      orgId,
      osFilter.projectId,
      osFilter.teamId,
      osFilter.q,
    ),
    orgId
      ? organizationRepository.getProjectsForOrganization(orgId)
      : Promise.resolve([]),
    orgId
      ? organizationRepository.listTeamsForOrganization(orgId)
      : Promise.resolve([]),
    attendanceRepository.getOrgTimezone(orgId),
    getOrgSupervisorSettings(orgId),
  ])

  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }))
  const teamOptions = teams.map((t) => ({
    id: t.id,
    name: t.name,
    projectName: t.projectName,
  }))

  const todayContent = (
    <>
      <DailyActivityTable
        rows={dailyActivity}
        timezone={timezone}
        filterBar={{
          prefix: "da",
          projects: projectOptions,
          teams: teamOptions,
          value: daFilter,
        }}
      />

      <RollCallSection
        rollCall={rollCall}
        filterBar={{
          prefix: "rc",
          projects: projectOptions,
          teams: teamOptions,
          value: rcFilter,
        }}
      />

      <OffSiteLogCard
        rows={offSiteRows}
        timezone={timezone}
        filterBar={{
          prefix: "os",
          projects: projectOptions,
          teams: teamOptions,
          value: osFilter,
        }}
      />
    </>
  )

  const analyticsContent = (
    <Suspense fallback={<TabSkeleton />}>
      <AnalyticsTab
        orgId={orgId}
        initialFrom={initialFrom}
        initialTo={initialTo}
        hsFilter={hsFilter}
        projectOptions={projectOptions}
        teamOptions={teamOptions}
      />
    </Suspense>
  )

  const performanceContent = (
    <Suspense fallback={<TabSkeleton />}>
      <PerformanceTab
        orgId={orgId}
        initialFrom={initialFrom}
        initialTo={initialTo}
        supervisorSettings={supervisorSettings}
        auFilter={auFilter}
        prFilter={prFilter}
        supFilter={supFilter}
        projectOptions={projectOptions}
        teamOptions={teamOptions}
      />
    </Suspense>
  )

  const historyContent = (
    <Suspense fallback={<TabSkeleton />}>
      <HistoryTab
        orgId={orgId}
        initialFrom={initialFrom}
        initialTo={initialTo}
        timezone={timezone}
        projectOptions={projectOptions}
        teamOptions={teamOptions}
      />
    </Suspense>
  )

  return (
    <div className="space-y-6">
      <AdminOverviewTabs
        today={todayContent}
        analytics={analyticsContent}
        performance={performanceContent}
        history={historyContent}
      />
    </div>
  )
}

function RollCallSection({
  rollCall,
  filterBar,
}: {
  rollCall: {
    late: RollCallPerson[]
    onLeave: RollCallPerson[]
    notClockedIn: RollCallPerson[]
  }
  filterBar: {
    prefix: string
    projects: { id: string; name: string }[]
    teams: { id: string; name: string; projectName: string }[]
    value: TableFilterValue
  }
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Roll call</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TableFilterBar
          prefix={filterBar.prefix}
          projects={filterBar.projects}
          teams={filterBar.teams}
          value={filterBar.value}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <RollCallCard
            title="Late today"
            accent="tertiary"
            icon={Clock}
            people={rollCall.late}
            emptyText="No one is late today."
            showLateMeta
          />
          <RollCallCard
            title="On leave today"
            accent="muted"
            icon={UmbrellaOff}
            people={rollCall.onLeave}
            emptyText="No approved leave today."
          />
          <RollCallCard
            title="Not clocked in"
            accent="destructive"
            icon={UserMinus}
            people={rollCall.notClockedIn}
            emptyText="Everyone is accounted for."
            subtitle="Haven't clocked in & not on leave"
          />
        </div>
      </CardContent>
    </Card>
  )
}

const ACCENT_CLASSES: Record<"tertiary" | "muted" | "destructive", string> = {
  tertiary: "bg-tertiary/10 text-tertiary",
  muted: "bg-primary/10 text-primary",
  destructive: "bg-destructive/10 text-destructive",
}

function RollCallCard({
  title,
  subtitle,
  accent,
  icon: Icon,
  people,
  emptyText,
  showLateMeta = false,
}: {
  title: string
  subtitle?: string
  accent: keyof typeof ACCENT_CLASSES
  icon: LucideIcon
  people: RollCallPerson[]
  emptyText: string
  showLateMeta?: boolean
}) {
  return (
    <Card className="bg-card backdrop-blur-none dark:bg-card">
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className={`rounded-2xl p-2.5 ${ACCENT_CLASSES[accent]}`}>
            <Icon className="h-[18px] w-[18px]" />
          </div>
          <div>
            <CardTitle>{title}</CardTitle>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {people.length}
        </span>
      </CardHeader>
      <CardContent>
        {people.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          <div className="nice-scrollbar -mr-2 max-h-[420px] space-y-2 overflow-y-auto pr-2">
            {people.map((person) => (
              <div
                key={person.id}
                className="rounded-2xl border border-border/60 bg-surface-low px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-sm font-bold">{person.name}</p>
                  {showLateMeta && person.lateByMin != null ? (
                    <span className="shrink-0 text-xs font-semibold text-tertiary">
                      +{person.lateByMin}m
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[person.jobTitle, person.project].filter(Boolean).join(" · ") ||
                    person.employeeId}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
