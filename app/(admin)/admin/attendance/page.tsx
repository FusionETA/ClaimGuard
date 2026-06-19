import {
  Clock,
  UmbrellaOff,
  UserMinus,
  type LucideIcon,
} from "lucide-react"

import { AdminOverviewTabs } from "@/components/attendance/admin-overview-tabs"
import { ApprovalAuditLog } from "@/components/attendance/approval-audit-log"
import { DailyActivityTable } from "@/components/attendance/daily-activity-table"
import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { OffSiteLogCard } from "@/components/attendance/off-site-log-card"
import { OrgHistoryPanel } from "@/components/attendance/org-history-panel"
import { SupervisorPerformanceCard } from "@/components/attendance/supervisor-performance-card"
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
  getActiveAdminPolicyScope,
  requireAdminModule,
} from "@/modules/organization/application/services/admin-access.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

import { loadSelfieStorageStatsAction } from "./actions"
import { loadOrgHistoryAction } from "./history-actions"
import {
  loadApprovalAuditLogForFiltersAction,
  loadOrgHoursSummaryForFiltersAction,
  loadPendingRejectedAuditLogForFiltersAction,
} from "./hours-summary-actions"
import { SelfieStorageCard } from "./selfie-storage-card"

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

  const supervisorSettings = await getOrgSupervisorSettings(orgId)
  const policyIdScope = await getActiveAdminPolicyScope()

  const [
    overview,
    stats,
    rollCall,
    initialHoursSummary,
    projects,
    teams,
    initialAudit,
    selfieStats,
    dailyActivity,
    supervisorPerformance,
    timezone,
    initialPendingRejected,
    offSiteRows,
    initialHistory,
  ] = await Promise.all([
    adminAttendanceService.getOrgOverview(orgId, null),
    adminAttendanceService.getAggregateStats(
      // 30-day window — server component, runs once per request; the
      // react-hooks/purity rule doesn't distinguish server from client
      // components, so disable explicitly for this one line.
      // eslint-disable-next-line react-hooks/purity
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      new Date(),
      orgId,
      null,
    ),
    adminAttendanceService.getTodayRollCall(
      orgId,
      rcFilter.projectId,
      rcFilter.teamId,
      rcFilter.q,
    ),
    adminAttendanceService.getOrgHoursSummary(
      orgId,
      new Date(initialFrom),
      new Date(initialTo),
      hsFilter.projectId,
      hsFilter.teamId,
      hsFilter.q,
    ),
    orgId
      ? organizationRepository.getProjectsForOrganization(orgId)
      : Promise.resolve([]),
    orgId
      ? organizationRepository.listTeamsForOrganization(orgId)
      : Promise.resolve([]),
    adminAttendanceService.getApprovalAuditLog(
      orgId,
      new Date(initialFrom),
      new Date(initialTo),
      auFilter.projectId,
      auFilter.teamId,
      auFilter.q,
      ["APPROVED"],
    ),
    loadSelfieStorageStatsAction(),
    adminAttendanceService.getDailyActivity(
      orgId,
      daFilter.projectId,
      daFilter.teamId,
      daFilter.q,
    ),
    supervisorSettings.enabled
      ? adminAttendanceService.getSupervisorPerformance({
          orgId,
          from: new Date(initialFrom),
          to: new Date(initialTo),
          slaMinutes: supervisorSettings.slaMinutes,
          projectId: supFilter.projectId,
          teamId: supFilter.teamId,
          q: supFilter.q,
        })
      : Promise.resolve([]),
    attendanceRepository.getOrgTimezone(orgId),
    adminAttendanceService.getApprovalAuditLog(
      orgId,
      new Date(initialFrom),
      new Date(initialTo),
      prFilter.projectId,
      prFilter.teamId,
      prFilter.q,
      ["PENDING", "REJECTED"],
    ),
    adminAttendanceService.getOffSiteClockIns(
      orgId,
      osFilter.projectId,
      osFilter.teamId,
      osFilter.q,
    ),
    adminAttendanceService.getOrgHistory({
      orgId,
      from: new Date(initialFrom),
      to: new Date(initialTo),
      page: 0,
      policyIdScope,
    }),
  ])

  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }))
  const teamOptions = teams.map((t) => ({
    id: t.id,
    name: t.name,
    projectName: t.projectName,
  }))

  const historyContent = (
    <OrgHistoryPanel
      initialFrom={initialFrom}
      initialTo={initialTo}
      initialRows={initialHistory.rows}
      initialTotal={initialHistory.total}
      loadAction={loadOrgHistoryAction}
      projects={projectOptions}
      teams={teamOptions}
      timezone={timezone}
    />
  )

  const hoursAction = loadOrgHoursSummaryForFiltersAction.bind(null, hsFilter)
  const auditAction = loadApprovalAuditLogForFiltersAction.bind(null, auFilter)
  const pendingRejectedAction = loadPendingRejectedAuditLogForFiltersAction.bind(
    null,
    prFilter,
  )

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
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
          <CardTitle>30-day rolling</CardTitle>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Last 30 days
          </span>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            {
              label: "Records",
              value: stats.totalAttendanceRecords.toLocaleString(),
              tone: "text-foreground",
            },
            {
              label: "Late instances",
              value: String(stats.totalLate),
              tone: "text-tertiary",
            },
            {
              label: "Missing",
              value: String(stats.totalMissing),
              tone: "text-destructive",
            },
            {
              label: "Leave days",
              value: String(stats.totalOnLeave),
              tone: "text-accent",
            },
          ].map((s) => (
            <div key={s.label}>
              <p className={`font-headline text-2xl font-extrabold ${s.tone}`}>
                {s.value}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <HoursSummaryPanel
        title="Working hours summary"
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialData={initialHoursSummary}
        loadAction={hoursAction}
        showEmployeeTable
        showTotals={false}
        filterBar={{
          prefix: "hs",
          projects: projectOptions,
          teams: teamOptions,
          value: hsFilter,
        }}
      />
    </>
  )

  const performanceContent = (
    <>
      <ApprovalAuditLog
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialRows={initialAudit}
        loadAction={auditAction}
        projectId={auFilter.projectId}
        mode="APPROVED"
        filterBar={{
          prefix: "au",
          projects: projectOptions,
          teams: teamOptions,
          value: auFilter,
        }}
      />

      <ApprovalAuditLog
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialRows={initialPendingRejected}
        loadAction={pendingRejectedAction}
        projectId={prFilter.projectId}
        mode="PENDING_REJECTED"
        filterBar={{
          prefix: "pr",
          projects: projectOptions,
          teams: teamOptions,
          value: prFilter,
        }}
      />

      {supervisorSettings.enabled ? (
        <SupervisorPerformanceCard
          rows={supervisorPerformance}
          slaMinutes={supervisorSettings.slaMinutes}
          filterBar={{
            prefix: "sup",
            projects: projectOptions,
            teams: teamOptions,
            value: supFilter,
          }}
        />
      ) : null}

      <SelfieStorageCard
        initialStats={selfieStats}
        defaultFrom={initialFrom}
        defaultTo={initialTo}
      />
    </>
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
    // Nested inside an outer "Roll call" Card. Both the outer and the
    // primitive Card default to `bg-card/94 backdrop-blur-sm`, and
    // stacking two translucent + backdrop-blurred layers on the page's
    // purple gradient triggers a Safari compositing bug (the gradient
    // bleeds through as a dark purple band). Override to an opaque
    // surface here so Safari + Chrome render the same.
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
      <CardContent className="space-y-2">
        {people.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          people.map((person) => (
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
          ))
        )}
      </CardContent>
    </Card>
  )
}
