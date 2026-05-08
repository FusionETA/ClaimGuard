import {
  Building2,
  ClipboardCheck,
  Clock,
  UmbrellaOff,
  UserMinus,
  Users,
  type LucideIcon,
} from "lucide-react"

import { MetricCard } from "@/components/claims/metric-card"
import { AdminOverviewTabs } from "@/components/attendance/admin-overview-tabs"
import { ApprovalAuditLog } from "@/components/attendance/approval-audit-log"
import { DailyActivityTable } from "@/components/attendance/daily-activity-table"
import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { SupervisorPerformanceCard } from "@/components/attendance/supervisor-performance-card"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getPrismaClient } from "@/lib/prisma"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import type { RollCallPerson } from "@/modules/attendance/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

import { loadSelfieStorageStatsAction } from "./actions"
import {
  loadApprovalAuditLogForFiltersAction,
  loadOrgHoursSummaryForFiltersAction,
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
  const prisma = getPrismaClient()
  if (!prisma) return { enabled: true, slaMinutes: 60 }
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { supervisorReportEnabled: true, supervisorSlaMinutes: true },
  })
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
  const orgId = resolveActiveOrgId(session) ?? null
  const params = (await searchParams) ?? {}

  const daFilter = readFilter(params, "da")
  const rcFilter = readFilter(params, "rc")
  const hsFilter = readFilter(params, "hs")
  const auFilter = readFilter(params, "au")
  const supFilter = readFilter(params, "sup")

  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()

  const supervisorSettings = await getOrgSupervisorSettings(orgId)

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
  ] = await Promise.all([
    adminAttendanceService.getOrgOverview(orgId, null),
    adminAttendanceService.getAggregateStats(
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
  ])

  const presentRate =
    overview.headcount > 0
      ? Math.round((overview.presentToday / overview.headcount) * 100)
      : 0

  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }))
  const teamOptions = teams.map((t) => ({
    id: t.id,
    name: t.name,
    projectName: t.projectName,
  }))

  const hoursAction = loadOrgHoursSummaryForFiltersAction.bind(null, hsFilter)
  const auditAction = loadApprovalAuditLogForFiltersAction.bind(null, auFilter)

  const todayContent = (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Headcount"
          value={String(overview.headcount)}
          icon={Users}
          detail="All staff"
          compact
        />
        <MetricCard
          title="Present today"
          value={String(overview.presentToday)}
          icon={Users}
          detail={`${presentRate}% present`}
          compact
        />
        <MetricCard
          title="Late today"
          value={String(overview.lateToday)}
          icon={Clock}
          detail="Past start time"
          compact
        />
        <MetricCard
          title="On leave"
          value={String(overview.onLeaveToday)}
          icon={UmbrellaOff}
          detail="Today"
          compact
        />
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
              <ClipboardCheck className="h-[18px] w-[18px]" />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Awaiting review
            </span>
          </div>
          <p className="mt-4 text-xs font-medium text-muted-foreground">
            Pending approvals (all teams)
          </p>
          <p className="mt-1 font-black tracking-tight text-[2rem]">
            {String(overview.pendingApprovals).padStart(2, "0")}
          </p>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <TableFilterBar
          prefix="da"
          projects={projectOptions}
          teams={teamOptions}
          value={daFilter}
        />
        <DailyActivityTable rows={dailyActivity} />
      </div>

      <div className="space-y-2">
        <TableFilterBar
          prefix="rc"
          projects={projectOptions}
          teams={teamOptions}
          value={rcFilter}
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
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
          <CardTitle>By project</CardTitle>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Today
          </span>
        </CardHeader>
        <CardContent className="space-y-2">
          {overview.byProject.length === 0 ? (
            <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
              No projects yet.
            </p>
          ) : (
            overview.byProject.map((p) => {
              const rate =
                p.headcount > 0
                  ? Math.round((p.presentToday / p.headcount) * 100)
                  : 0
              return (
                <div
                  key={p.project}
                  className="flex items-center gap-3 rounded-2xl border border-border/60 bg-surface-low px-4 py-3"
                >
                  <div className="rounded-xl bg-primary/10 p-2 text-primary">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {p.project}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.presentToday}/{p.headcount} present · {p.lateToday} late
                    </p>
                  </div>
                  <span className="text-sm font-bold text-foreground">
                    {rate}%
                  </span>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </>
  )

  const trendsContent = (
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

      <div className="space-y-2">
        <TableFilterBar
          prefix="hs"
          projects={projectOptions}
          teams={teamOptions}
          value={hsFilter}
        />
        <HoursSummaryPanel
          title="Working hours summary"
          initialFrom={initialFrom}
          initialTo={initialTo}
          initialData={initialHoursSummary}
          loadAction={hoursAction}
          showEmployeeTable
        />
      </div>

      <div className="space-y-2">
        <TableFilterBar
          prefix="au"
          projects={projectOptions}
          teams={teamOptions}
          value={auFilter}
        />
        <ApprovalAuditLog
          initialFrom={initialFrom}
          initialTo={initialTo}
          initialRows={initialAudit}
          loadAction={auditAction}
          projectId={auFilter.projectId}
        />
      </div>

      {supervisorSettings.enabled ? (
        <div className="space-y-2">
          <TableFilterBar
            prefix="sup"
            projects={projectOptions}
            teams={teamOptions}
            value={supFilter}
          />
          <SupervisorPerformanceCard
            rows={supervisorPerformance}
            slaMinutes={supervisorSettings.slaMinutes}
          />
        </div>
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
      <AdminOverviewTabs today={todayContent} trends={trendsContent} />
    </div>
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
    <Card>
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
