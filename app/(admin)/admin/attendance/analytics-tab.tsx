import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
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
  // The summary stats (records / late / missing / leave) now ride inside the
  // hours-summary payload, so they follow the From / To filter instead of a
  // separate fixed "30-day rolling" card that pushed the table down the page.
  const initialHoursSummary = await adminAttendanceService.getOrgHoursSummary(
    orgId,
    new Date(initialFrom),
    new Date(initialTo),
    hsFilter.projectId,
    hsFilter.teamId,
    hsFilter.q,
  )

  const hoursAction = loadOrgHoursSummaryForFiltersAction.bind(null, hsFilter)

  return (
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
  )
}
