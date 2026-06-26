import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ArrowRight, CalendarDays, ClipboardCheck, CircleDollarSign, Clock3, FileCheck2, Wallet } from "lucide-react"

import { MetricCard } from "@/components/claims/metric-card"
import { SpendLimitsCard } from "@/components/claims/spend-limits-card"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/attendance/ui/card"
import { getEmployeeDashboard, getEmployeeClaimSubmissionData } from "@/modules/claims/application/services/employee-portal.service"
import { formatCurrency } from "@/lib/utils"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { countPendingClaimsForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"
import { countPendingApprovalsForReviewer as countPendingLeaveApprovalsForReviewer } from "@/modules/leave/application/services/leave-application.service"
import { listEmployeeBalancesForUser } from "@/modules/leave/application/services/leave-entitlements.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import type { ClockEventLite } from "@/modules/attendance/domain/models"
import {
  DEFAULT_MODULE_ACCESS,
  moduleAccessForPolicy,
} from "@/modules/policy/domain/models"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import { getEmployeePayslipsPageData } from "@/modules/payroll/application/services/employee-payroll.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

import { ClockCard } from "./attendance/clock-card"
import { DashboardQuickActions } from "./dashboard-quick-actions"

function deriveClockState(events: ClockEventLite[]): "IN" | "OUT" {
  const last = [...events]
    .reverse()
    .find(
      (e) =>
        (e.kind === "CLOCK_IN" || e.kind === "CLOCK_OUT") &&
        e.status !== "REJECTED",
    )
  return last?.kind === "CLOCK_IN" ? "IN" : "OUT"
}

function deriveLatestRejection(events: ClockEventLite[]): ClockEventLite | null {
  const clockEvents = events.filter(
    (e) => e.kind === "CLOCK_IN" || e.kind === "CLOCK_OUT",
  )
  const last = [...clockEvents].reverse()[0]
  return last && last.status === "REJECTED" ? last : null
}

export default async function EmployeeDashboardPage() {
  const session = await requirePortalSession("EMPLOYEE")

  // Resolve the employee's policy first so we can skip data fetches for
  // disabled modules and hide their dashboard widgets entirely.
  const policy = await policyRepository.findForUserId(session.userId)
  const moduleAccess = policy
    ? moduleAccessForPolicy(policy)
    : DEFAULT_MODULE_ACCESS

  // Claims-side data — only when the policy allows the Claims module.
  // `getEmployeeDashboard` projects the totals that drive the
  // welcome/metrics cards; skip when the module is off.
  const claimsData = moduleAccess.claims
    ? await getEmployeeDashboard()
    : null
  if (moduleAccess.claims && !claimsData) redirect("/login")

  const isSupervisor = session.role === "SUPERVISOR"
  const orgId = resolveActiveOrgId(session)
  const [
    attendanceDashboard,
    projects,
    pendingApprovals,
    pendingClaimApprovals,
    pendingLeaveApprovals,
    leaveBalances,
    leaveProfileId,
    leaveOrganization,
    claimSubmissionData,
    payslipPageData,
  ] = await Promise.all([
    moduleAccess.attendance
      ? employeeAttendanceService.getEmployeeDashboard(session.userId)
      : Promise.resolve(null),
    moduleAccess.attendance
      ? employeeAttendanceService.getAvailableProjects(session.userId)
      : Promise.resolve([]),
    isSupervisor && moduleAccess.attendance
      ? supervisorAttendanceService.countPendingApprovalsForSupervisor(session.userId)
      : Promise.resolve(0),
    isSupervisor && moduleAccess.claims
      ? countPendingClaimsForSupervisor(session.email)
      : Promise.resolve(0),
    isSupervisor && moduleAccess.leave
      ? countPendingLeaveApprovalsForReviewer(session.userId)
      : Promise.resolve(0),
    moduleAccess.leave
      ? listEmployeeBalancesForUser(session.userId, new Date().getUTCFullYear())
      : Promise.resolve([]),
    moduleAccess.leave
      ? leaveRepository.findEmployeeProfileIdByUserId(session.userId)
      : Promise.resolve(null),
    moduleAccess.leave && orgId
      ? organizationRepository.getOrganizationById(orgId)
      : Promise.resolve(null),
    moduleAccess.claims
      ? getEmployeeClaimSubmissionData()
      : Promise.resolve(null),
    // Latest submitted payslips. The repo already sorts newest-first;
    // we only render the first row on the dashboard.
    getEmployeePayslipsPageData(),
  ])
  const latestPayslip = payslipPageData?.payslips[0] ?? null
  const employeeJoinDate = leaveProfileId
    ? await leaveRepository.getEmployeeJoinDate(leaveProfileId)
    : null
  const allowForecastedLeaveApply =
    leaveOrganization?.allowForecastedLeaveApply ?? false
  // Selfie + geofence requirements come from the already-loaded policy
  // (line 55) — no need to re-query the employee profile.
  const requiresSelfieOnClockIn = policy?.requireSelfie ?? false
  const requiresSelfieOnClockOut = policy?.requireClockOutSelfie ?? false
  const otDailyThresholdMinutes = policy?.otDailyThresholdMinutes ?? 480
  const enforceGeofence = policy?.requireGeofence ?? true
  const captureLocationEnabled = policy?.geolocationEnabled ?? true
  const captureLocationOnClockIn = policy?.captureLocationOnClockIn ?? true
  const captureLocationOnClockOut = policy?.captureLocationOnClockOut ?? true
  const captureLocationOnBreakStart = policy?.captureLocationOnBreakStart ?? true
  const captureLocationOnBreakEnd = policy?.captureLocationOnBreakEnd ?? true
  const clockState = attendanceDashboard
    ? deriveClockState(attendanceDashboard.todayEvents)
    : "OUT"
  const activeProject = attendanceDashboard?.today?.project ?? null
  const activeLocation = attendanceDashboard?.today?.location ?? null
  const nowIso = new Date().toISOString()

  const showSupervisorAttendanceCard =
    isSupervisor && moduleAccess.attendance
  const showSupervisorClaimsCard = isSupervisor && moduleAccess.claims
  const showSupervisorLeaveCard = isSupervisor && moduleAccess.leave
  const supervisorCardCount =
    Number(showSupervisorAttendanceCard) +
    Number(showSupervisorClaimsCard) +
    Number(showSupervisorLeaveCard)

  return (
    <div className="space-y-4 sm:space-y-6">
      {moduleAccess.attendance && attendanceDashboard ? (
        <section className="attendance-module !bg-transparent">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Today&apos;s attendance
              </p>
              <h2 className="mt-0.5 font-headline text-lg font-extrabold text-foreground sm:text-xl">
                {clockState === "IN" ? "On the clock" : "Ready when you are"}
              </h2>
            </div>
            <Link
              href="/employee/attendance"
              className="shrink-0 text-xs font-bold text-primary hover:underline"
            >
              View full →
            </Link>
          </div>
          <ClockCard
            state={clockState}
            projects={projects}
            activeProject={activeProject}
            activeLocation={activeLocation}
            activeProjectLat={attendanceDashboard.activeProjectCoords?.latitude ?? null}
            activeProjectLng={attendanceDashboard.activeProjectCoords?.longitude ?? null}
            geofenceRadiusMeters={attendanceDashboard.geofenceRadiusMeters}
            now={nowIso}
            onBreak={attendanceDashboard.today?.onBreak ?? false}
            currentBreakStartedAt={attendanceDashboard.today?.currentBreakStartedAt ?? null}
            requiresSelfieOnClockIn={requiresSelfieOnClockIn}
            requiresSelfieOnClockOut={requiresSelfieOnClockOut}
            otDailyThresholdMinutes={otDailyThresholdMinutes}
            enforceGeofence={enforceGeofence}
            captureLocationEnabled={captureLocationEnabled}
            captureLocationOnClockIn={captureLocationOnClockIn}
            captureLocationOnClockOut={captureLocationOnClockOut}
            captureLocationOnBreakStart={captureLocationOnBreakStart}
            captureLocationOnBreakEnd={captureLocationOnBreakEnd}
            todayRecord={attendanceDashboard.today}
            latestRejection={deriveLatestRejection(attendanceDashboard.todayEvents)}
            pendingApproval={attendanceDashboard.pendingApproval}
          />
        </section>
      ) : null}

      {supervisorCardCount > 0 ? (
        <div
          className={
            supervisorCardCount === 1
              ? "grid gap-3"
              : supervisorCardCount === 2
                ? "grid gap-3 sm:grid-cols-2"
                : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          {showSupervisorAttendanceCard ? (
            <Link
              href="/employee/attendance/approvals"
              className="attendance-module !bg-transparent block"
            >
              <Card className="flex items-center gap-3 p-4">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <ClipboardCheck className="h-5 w-5" />
                  {pendingApprovals > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                      {pendingApprovals > 99 ? "99+" : pendingApprovals}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-foreground">Attendance approvals</p>
                  <p className="text-xs text-muted-foreground">
                    {pendingApprovals === 0
                      ? "All caught up"
                      : `${pendingApprovals} waiting for your review`}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Card>
            </Link>
          ) : null}

          {showSupervisorClaimsCard ? (
            <Link
              href="/employee/review"
              className="attendance-module !bg-transparent block"
            >
              <Card className="flex items-center gap-3 p-4">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <CircleDollarSign className="h-5 w-5" />
                  {pendingClaimApprovals > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                      {pendingClaimApprovals > 99 ? "99+" : pendingClaimApprovals}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-foreground">Claims queue</p>
                  <p className="text-xs text-muted-foreground">
                    {pendingClaimApprovals === 0
                      ? "All caught up"
                      : `${pendingClaimApprovals} waiting for your review`}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Card>
            </Link>
          ) : null}

          {showSupervisorLeaveCard ? (
            <Link
              href={"/employee/leave/approvals" as Route}
              className="attendance-module !bg-transparent block"
            >
              <Card className="flex items-center gap-3 p-4">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <CalendarDays className="h-5 w-5" />
                  {pendingLeaveApprovals > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                      {pendingLeaveApprovals > 99 ? "99+" : pendingLeaveApprovals}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-foreground">Leave approvals</p>
                  <p className="text-xs text-muted-foreground">
                    {pendingLeaveApprovals === 0
                      ? "All caught up"
                      : `${pendingLeaveApprovals} waiting for your review`}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Card>
            </Link>
          ) : null}
        </div>
      ) : null}

      <Link
        href="/employee/payslips"
        className="block"
        aria-label="View all payslips"
      >
        <Card className="flex items-center gap-3 p-4 transition hover:border-primary/40">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Wallet className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Latest payslip
            </p>
            {latestPayslip ? (
              <>
                <p className="truncate text-sm font-bold text-foreground">
                  {periodLabel(latestPayslip.periodYear, latestPayslip.periodMonth)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Gross {formatMyr(latestPayslip.grossPay)} · Net{" "}
                  {formatMyr(latestPayslip.netPay)}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-foreground">No payslips yet</p>
                <p className="text-xs text-muted-foreground">
                  They&apos;ll appear here once payroll finalises your first run.
                </p>
              </>
            )}
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Card>
      </Link>

      {moduleAccess.claims && claimsData ? (
        <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Card className="overflow-hidden border border-border/70 bg-card/94 text-foreground shadow-ambient backdrop-blur-sm">
            <CardHeader className="p-5 sm:p-8 xl:p-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                  Welcome back
                </p>
                <CardTitle className="text-2xl font-black sm:text-4xl xl:text-[2.25rem]">
                  {claimsData.employee.name}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 p-5 pt-0 sm:grid-cols-2 sm:gap-4 sm:p-8 sm:pt-0 xl:p-6 xl:pt-0">
              <div className="hidden rounded-[24px] border border-border/70 bg-surface-low p-5 sm:block xl:p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Total reimbursed
                </p>
                <p className="mt-3 text-4xl font-black tracking-tight xl:text-[2.5rem]">
                  {formatCurrency(claimsData.totals.reimbursed)}
                </p>
                <p className="mt-2 text-sm text-muted-foreground xl:text-[0.95rem]">
                  YTD across approved and paid claims
                </p>
              </div>
              <div className="grid gap-3 sm:gap-4 xl:content-start">
                <DashboardQuickActions
                  chartAccounts={claimSubmissionData?.chartAccounts ?? []}
                  mileageAccounts={claimSubmissionData?.mileageAccounts ?? []}
                  bankAccounts={claimSubmissionData?.bankAccounts ?? []}
                  defaultMileageRate={claimSubmissionData?.organization?.defaultMileageRate}
                  mileageUnit={claimSubmissionData?.organization?.mileageUnit ?? "KM"}
                  claimRunPreview={claimSubmissionData?.claimRunPreview}
                  organizationName={claimSubmissionData?.organization?.name}
                  employeeProjects={claimSubmissionData?.employeeProjects ?? []}
                  allowedCurrencies={claimSubmissionData?.organization?.allowedCurrencies}
                  defaultCurrency={claimSubmissionData?.organization?.defaultCurrency}
                  // Power the consolidated 'Request leave' button — opens
                  // the same apply-for-leave dialog the standalone
                  // LeaveQuickAction card used to render. Gated by
                  // moduleAccess.leave at the load site so when leave is
                  // disabled the button hides automatically.
                  leaveBalances={
                    moduleAccess.leave && leaveBalances.length > 0
                      ? leaveBalances.map((b) => ({
                          ...b,
                          carriedExpiresAt: b.carriedExpiresAt
                            ? b.carriedExpiresAt.toISOString()
                            : null,
                        }))
                      : undefined
                  }
                  joinDate={employeeJoinDate ? employeeJoinDate.toISOString() : null}
                  allowForecastedLeaveApply={allowForecastedLeaveApply}
                />
              </div>
            </CardContent>
          </Card>

          <div className="hidden gap-4 md:grid-cols-3 xl:grid xl:grid-cols-1">
            <MetricCard
              title="Awaiting review"
              value={String(claimsData.totals.pending)}
              icon={Clock3}
              detail="Open queue"
            />
            <MetricCard
              title="Approved"
              value={String(claimsData.totals.approved)}
              icon={FileCheck2}
              detail="Ready for payout"
            />
            <MetricCard
              title="Paid"
              value={String(claimsData.totals.paid)}
              icon={CircleDollarSign}
              detail="Completed"
            />
          </div>
        </div>
      ) : null}

      {/* Spend limits — visible only when at least one account has a configured
          MONTHLY/YEARLY cap. Hidden when the Claims module is disabled. */}
      {moduleAccess.claims ? (
        <SpendLimitsCard
          accounts={[
            ...(claimSubmissionData?.chartAccounts ?? []),
            ...(claimSubmissionData?.mileageAccounts ?? []),
          ]}
        />
      ) : null}

      {/* Empty state when every module is disabled. Keeps the page from
          looking blank for employees with a "no access" policy. */}
      {!moduleAccess.attendance && !moduleAccess.claims && !moduleAccess.leave ? (
        <Card className="p-6 text-center">
          <p className="text-sm font-semibold text-foreground">
            Welcome, {session.name.split(" ")[0] ?? session.name}.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Your administrator hasn&apos;t enabled any modules on your
            policy yet. Reach out to them if this looks wrong.
          </p>
        </Card>
      ) : null}
    </div>
  )
}

function formatMyr(value: number) {
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 2,
  }).format(value)
}
