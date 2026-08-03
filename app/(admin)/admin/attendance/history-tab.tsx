import { OrgHistoryPanel } from "@/components/attendance/org-history-panel"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"

import {
  loadOrgHistoryAction,
  loadOrgHistoryEmployeesAction,
} from "./history-actions"

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
  const range = {
    orgId,
    from: new Date(initialFrom),
    to: new Date(initialTo),
    policyIdScope,
  }
  // Seed the export scope from the same filter the table opens on, so
  // the dialog is already correct before the admin touches anything.
  const [initialHistory, scopedEmployees] = await Promise.all([
    adminAttendanceService.getOrgHistory({ ...range, page: 0 }),
    adminAttendanceService.getOrgHistoryEmployees(range),
  ])

  return (
    <OrgHistoryPanel
      initialFrom={initialFrom}
      initialTo={initialTo}
      initialRows={initialHistory.rows}
      initialTotal={initialHistory.total}
      loadAction={loadOrgHistoryAction}
      loadEmployeesAction={loadOrgHistoryEmployeesAction}
      projects={projectOptions}
      teams={teamOptions}
      timezone={timezone}
      employees={scopedEmployees}
    />
  )
}
