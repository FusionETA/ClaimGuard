import { Suspense } from "react"

import { AdminOverviewTabs } from "@/components/attendance/admin-overview-tabs"
import { DailyActivityTable } from "@/components/attendance/daily-activity-table"
import { type TableFilterValue } from "@/components/attendance/table-filter-bar"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
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
  const hsFilter = readFilter(params, "hs")
  const auFilter = readFilter(params, "au")
  const supFilter = readFilter(params, "sup")

  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()

  // Only fetch what the Today tab needs + shared filter data. The Daily
  // activity table now subsumes the old roll call + off-site cards, so it's
  // the single "today" data source (every in-scope employee, pill-filtered).
  const [dailyActivity, projects, teams, timezone, supervisorSettings] =
    await Promise.all([
      adminAttendanceService.getDailyActivity(
        orgId,
        daFilter.projectId,
        daFilter.teamId,
        daFilter.q,
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
