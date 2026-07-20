import { OrgHistoryPanel } from "@/components/attendance/org-history-panel"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"

import { loadOrgHistoryAction } from "./history-actions"

export async function HistoryTab({
  orgId,
  initialFrom,
  initialTo,
  timezone,
  projectOptions,
  teamOptions,
}: {
  orgId: string | null
  initialFrom: string
  initialTo: string
  timezone: string
  projectOptions: { id: string; name: string }[]
  teamOptions: { id: string; name: string; projectName: string }[]
}) {
  const policyIdScope = await getActiveAdminPolicyScope()
  const [initialHistory, orgEmployees] = await Promise.all([
    adminAttendanceService.getOrgHistory({
      orgId,
      from: new Date(initialFrom),
      to: new Date(initialTo),
      page: 0,
      policyIdScope,
    }),
    orgId ? attendanceRepository.getOrgEmployeeList(orgId) : Promise.resolve([]),
  ])

  return (
    <OrgHistoryPanel
      initialFrom={initialFrom}
      initialTo={initialTo}
      initialRows={initialHistory.rows}
      initialTotal={initialHistory.total}
      loadAction={loadOrgHistoryAction}
      projects={projectOptions}
      teams={teamOptions}
      timezone={timezone}
      employees={orgEmployees.map((e) => ({ id: e.id, name: e.name }))}
    />
  )
}
