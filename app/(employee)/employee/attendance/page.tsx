import { HoursSummaryPanel } from "@/components/attendance/hours-summary-panel"
import { requirePortalSession } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { formatHm } from "@/modules/attendance/domain/hours-summary"
import { requireModuleAccess } from "@/modules/policy/application/guards"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

import { EmployeeAttendanceDashboardView } from "./dashboard-view"
import { loadMyHoursSummaryAction } from "./hours-summary-actions"

async function loadEmployeeProfileExtras(userId: string): Promise<{
  otPayoutMethod: "CASH" | "TIME_BANK"
  otTimeBalanceMin: number
  requiresSelfieOnClockIn: boolean
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: { otPayoutMethod: true, otTimeBalanceMin: true, payoutMethod: true },
  })
  if (!profile) return null
  return {
    otPayoutMethod:
      profile.otPayoutMethod === "TIME_BANK" ? "TIME_BANK" : "CASH",
    otTimeBalanceMin: profile.otTimeBalanceMin,
    requiresSelfieOnClockIn: profile.payoutMethod === "HOURLY",
  }
}

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
  const initialFrom = startOfMonthIso()
  const initialTo = todayIso()
  const [dashboard, workingHours, projects, hoursSummary, profileExtras, policy] = await Promise.all([
    employeeAttendanceService.getEmployeeDashboard(session.userId),
    employeeAttendanceService.getWorkingHours(session.userId),
    employeeAttendanceService.getAvailableProjects(session.userId),
    employeeAttendanceService.getHoursSummary(
      session.userId,
      new Date(initialFrom),
      new Date(initialTo),
    ),
    loadEmployeeProfileExtras(session.userId),
    policyRepository.findForUserId(session.userId),
  ])
  // Default to enforcing geofence when no policy is assigned (legacy
  // behavior). Admins disable it per-policy in Settings → Policies.
  const enforceGeofence = policy?.requireGeofence ?? true
  // Selfie requirement: prefer the policy flag when available, fall back
  // to the legacy "hourly == selfie" heuristic so un-backfilled orgs
  // keep their current behavior.
  const requiresSelfieOnClockIn = policy
    ? policy.requireSelfie
    : profileExtras?.requiresSelfieOnClockIn ?? false

  return (
    <div className="space-y-4">
      <EmployeeAttendanceDashboardView
        firstName={session.name.split(" ")[0] ?? session.name}
        dashboard={dashboard}
        workingHours={workingHours}
        projects={projects}
        requiresSelfieOnClockIn={requiresSelfieOnClockIn}
        enforceGeofence={enforceGeofence}
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
