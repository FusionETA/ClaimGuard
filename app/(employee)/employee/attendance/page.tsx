import { HoursProgress } from "@/components/attendance/hours-progress"
import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { formatHm } from "@/modules/attendance/domain/hours-summary"
import { requireModuleAccess } from "@/modules/policy/application/guards"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

import { EmployeeAttendanceDashboardView } from "./dashboard-view"
import { loadMyHoursSummaryAction } from "./hours-summary-actions"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export default async function EmployeeAttendancePage() {
  const session = await requirePortalSession("EMPLOYEE")
  await requireModuleAccess("attendance")
  const orgId = resolveActiveOrgId(session) ?? null
  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const [dashboard, workingHours, projects, hoursSummary, profileExtras, policy, progress, timezone] = await Promise.all([
    employeeAttendanceService.getEmployeeDashboard(session.userId),
    employeeAttendanceService.getWorkingHours(session.userId),
    employeeAttendanceService.getAvailableProjects(session.userId),
    employeeAttendanceService.getHoursSummary(
      session.userId,
      new Date(initialFrom),
      new Date(initialTo),
    ),
    employeeAttendanceService.getProfileExtras(session.userId),
    policyRepository.findForUserId(session.userId),
    employeeAttendanceService.getProgress(session.userId),
    attendanceRepository.getOrgTimezone(orgId),
  ])
  // Default to enforcing geofence when no policy is assigned (legacy
  // behavior). Admins disable it per-policy in Settings → Policies.
  const enforceGeofence = policy?.requireGeofence ?? true
  const requiresSelfieOnClockIn = policy?.requireSelfie ?? profileExtras?.requiresSelfieOnClockIn ?? false

  return (
    <div className="space-y-4">
      <EmployeeAttendanceDashboardView
        firstName={session.name.split(" ")[0] ?? session.name}
        dashboard={dashboard}
        workingHours={workingHours}
        projects={projects}
        requiresSelfieOnClockIn={requiresSelfieOnClockIn}
        enforceGeofence={enforceGeofence}
        timezone={timezone}
      />
      <HoursProgress
        weekly={{
          actualMin: progress.week.actualMin,
          expectedMin: progress.week.expectedMin,
        }}
        monthly={{
          actualMin: progress.month.actualMin,
          expectedMin: progress.month.expectedMin,
        }}
      />
      <HoursSummaryPanel
        title="My hours summary"
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialData={hoursSummary}
        loadAction={loadMyHoursSummaryAction}
      />
      {profileExtras?.otPayoutMethod === "TIME_BANK" ? (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-4 text-sm dark:bg-amber-950/30">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            OT time bank
          </p>
          <p className="mt-1 text-2xl font-bold text-amber-700 dark:text-amber-300">
            {formatHm(profileExtras.otTimeBalanceMin)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Approved overtime is banked as time-off minutes that you can
            redeem later.
          </p>
        </div>
      ) : null}
    </div>
  )
}
