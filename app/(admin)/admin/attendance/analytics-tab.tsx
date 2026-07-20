import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import type { TableFilterValue } from "@/components/attendance/table-filter-bar"

import { loadOrgHoursSummaryForFiltersAction } from "./hours-summary-actions"

export async function AnalyticsTab({
  orgId,
  initialFrom,
  initialTo,
  hsFilter,
  projectOptions,
  teamOptions,
}: {
  orgId: string | null
  initialFrom: string
  initialTo: string
  hsFilter: TableFilterValue
  projectOptions: { id: string; name: string }[]
  teamOptions: { id: string; name: string; projectName: string }[]
}) {
  const [stats, initialHoursSummary] = await Promise.all([
    adminAttendanceService.getAggregateStats(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      new Date(),
      orgId,
      null,
    ),
    adminAttendanceService.getOrgHoursSummary(
      orgId,
      new Date(initialFrom),
      new Date(initialTo),
      hsFilter.projectId,
      hsFilter.teamId,
      hsFilter.q,
    ),
  ])

  const hoursAction = loadOrgHoursSummaryForFiltersAction.bind(null, hsFilter)

  return (
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
            { label: "Records", value: stats.totalAttendanceRecords.toLocaleString(), tone: "text-foreground" },
            { label: "Late instances", value: String(stats.totalLate), tone: "text-tertiary" },
            { label: "Missing", value: String(stats.totalMissing), tone: "text-destructive" },
            { label: "Leave days", value: String(stats.totalOnLeave), tone: "text-accent" },
          ].map((s) => (
            <div key={s.label}>
              <p className={`font-headline text-2xl font-extrabold ${s.tone}`}>{s.value}</p>
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
}
