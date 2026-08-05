import { ApprovalAuditLog } from "@/components/attendance/approval-audit-log"
import { SupervisorPerformanceCard } from "@/components/attendance/supervisor-performance-card"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import type { TableFilterValue } from "@/components/attendance/table-filter-bar"

import { SelfieStorageCard } from "./selfie-storage-card"
import { loadSelfieStorageStatsAction } from "./actions"
import { loadApprovalAuditLogForFiltersAction } from "./hours-summary-actions"

export async function PerformanceTab({
  orgId,
  initialFrom,
  initialTo,
  supervisorSettings,
  auFilter,
  supFilter,
  projectOptions,
  teamOptions,
}: {
  orgId: string | null
  initialFrom: string
  initialTo: string
  supervisorSettings: { enabled: boolean; slaMinutes: number }
  auFilter: TableFilterValue
  supFilter: TableFilterValue
  projectOptions: { id: string; name: string }[]
  teamOptions: { id: string; name: string; projectName: string }[]
}) {
  const [initialAudit, supervisorPerformance, selfieStats] = await Promise.all([
    adminAttendanceService.getApprovalAuditLog(
      orgId,
      new Date(initialFrom),
      new Date(initialTo),
      auFilter.projectId,
      auFilter.teamId,
      auFilter.q,
      ["APPROVED", "PENDING", "REJECTED"],
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
    loadSelfieStorageStatsAction(),
  ])

  const auditAction = loadApprovalAuditLogForFiltersAction.bind(null, auFilter)

  return (
    <>
      <ApprovalAuditLog
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialRows={initialAudit}
        loadAction={auditAction}
        projectId={auFilter.projectId}
        filterBar={{
          prefix: "au",
          projects: projectOptions,
          teams: teamOptions,
          value: auFilter,
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
}
