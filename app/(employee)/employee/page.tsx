import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, ClipboardCheck, CircleDollarSign, Clock3, FileCheck2 } from "lucide-react"

import { MetricCard } from "@/components/claims/metric-card"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/attendance/ui/card"
import { getEmployeeDashboard, getEmployeeClaimSubmissionData } from "@/modules/claims/application/services/employee-portal.service"
import { formatCurrency } from "@/lib/utils"
import { requirePortalSession } from "@/lib/auth/session"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { countPendingClaimsForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"
import type { ClockEventLite } from "@/modules/attendance/domain/models"

import { ClockCard } from "./attendance/clock-card"
import { DashboardQuickActions } from "./dashboard-quick-actions"

function deriveClockState(events: ClockEventLite[]): "IN" | "OUT" {
  const last = [...events]
    .reverse()
    .find((e) => e.kind === "CLOCK_IN" || e.kind === "CLOCK_OUT")
  return last?.kind === "CLOCK_IN" ? "IN" : "OUT"
}

export default async function EmployeeDashboardPage() {
  const session = await requirePortalSession("EMPLOYEE")
  const data = await getEmployeeDashboard()
  if (!data) redirect("/login")

  const isSupervisor = session.role === "SUPERVISOR"
  const [attendanceDashboard, projects, pendingApprovals, pendingClaimApprovals, claimSubmissionData] = await Promise.all([
    employeeAttendanceService.getEmployeeDashboard(session.userId),
    employeeAttendanceService.getAvailableProjects(session.userId),
    isSupervisor
      ? supervisorAttendanceService.countPendingApprovalsForSupervisor(session.userId)
      : Promise.resolve(0),
    isSupervisor
      ? countPendingClaimsForSupervisor(session.email)
      : Promise.resolve(0),
    getEmployeeClaimSubmissionData(),
  ])
  const clockState = deriveClockState(attendanceDashboard.todayEvents)
  const activeProject = attendanceDashboard.today?.project ?? null
  const activeLocation = attendanceDashboard.today?.location ?? null
  const nowIso = new Date().toISOString()

  return (
    <div className="space-y-4 sm:space-y-6">
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
        />
      </section>

      {isSupervisor ? (
        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>
      ) : null}

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="overflow-hidden border border-border/70 bg-card/94 text-foreground shadow-ambient backdrop-blur-sm">
          <CardHeader className="p-5 sm:p-8 xl:p-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                Welcome back
              </p>
              <CardTitle className="text-2xl font-black sm:text-4xl xl:text-[2.25rem]">
                {data.employee.name}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 pt-0 sm:grid-cols-2 sm:gap-4 sm:p-8 sm:pt-0 xl:p-6 xl:pt-0">
            <div className="hidden rounded-[24px] border border-border/70 bg-surface-low p-5 sm:block xl:p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Total reimbursed
              </p>
              <p className="mt-3 text-4xl font-black tracking-tight xl:text-[2.5rem]">
                {formatCurrency(data.totals.reimbursed)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground xl:text-[0.95rem]">
                YTD across approved and paid claims
              </p>
            </div>
            <div className="grid gap-3 sm:gap-4 xl:content-start">
              <DashboardQuickActions
                chartAccounts={claimSubmissionData?.chartAccounts ?? []}
                bankAccounts={claimSubmissionData?.bankAccounts ?? []}
                claimRunPreview={claimSubmissionData?.claimRunPreview}
                organizationName={claimSubmissionData?.organization?.name}
              />
            </div>
          </CardContent>
        </Card>

        <div className="hidden gap-4 md:grid-cols-3 xl:grid xl:grid-cols-1">
          <MetricCard
            title="Awaiting review"
            value={String(data.totals.pending)}
            icon={Clock3}
            detail="Open queue"
          />
          <MetricCard
            title="Approved"
            value={String(data.totals.approved)}
            icon={FileCheck2}
            detail="Ready for payout"
          />
          <MetricCard
            title="Paid"
            value={String(data.totals.paid)}
            icon={CircleDollarSign}
            detail="Completed"
          />
        </div>
      </div>

    </div>
  )
}
