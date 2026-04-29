import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Clock,
  TimerReset,
  TrendingUp,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import type {
  AdminExecutiveOverview,
  AttendanceProjectHealth,
  ProjectClaimSpend,
  SlowOtApprover,
  StalePendingClaim,
  UpcomingClaimRun,
} from "@/modules/claims/application/services/admin-executive-overview.service"

export function ExecutiveOverview({ data }: { data: AdminExecutiveOverview }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <ProjectClaimsCard projects={data.projectSpend} />
        <AttendanceHealthCard projects={data.attendanceHealth} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SlowOtApproversCard approvers={data.slowOtApprovers} />
        <StalePendingClaimsCard claims={data.stalePendingClaims} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <UpcomingClaimRunCard run={data.upcomingClaimRun} />
        <FailedXeroSyncsCard
          total={data.failedXeroSyncs.total}
          samples={data.failedXeroSyncs.samples}
        />
      </div>
    </div>
  )
}

// ─── Card 1: Project claims breakdown ────────────────────────────────────────

function ProjectClaimsCard({ projects }: { projects: ProjectClaimSpend[] }) {
  const total = projects.reduce((sum, p) => sum + p.totalAmount, 0)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <TrendingUp className="h-[18px] w-[18px]" />
          </div>
          <CardTitle>Project claims</CardTitle>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          This month
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {projects.length === 0 ? (
          <EmptyState text="No claims submitted this month yet." />
        ) : (
          <>
            {projects.map((p) => {
              const pct = total > 0 ? Math.round((p.totalAmount / total) * 100) : 0
              return (
                <div
                  key={p.project}
                  className="rounded-2xl border border-border/60 bg-surface-low p-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-bold">{p.project}</p>
                    <p className="font-headline text-base font-extrabold text-foreground">
                      {formatCurrency(p.totalAmount)}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/50">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {p.claimCount} claim{p.claimCount === 1 ? "" : "s"} · {pct}%
                    </p>
                  </div>
                </div>
              )
            })}
            <p className="px-1 pt-1 text-xs text-muted-foreground">
              Total this month:{" "}
              <span className="font-semibold text-foreground">{formatCurrency(total)}</span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Card 2: Attendance health by project ────────────────────────────────────

function AttendanceHealthCard({ projects }: { projects: AttendanceProjectHealth[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <Building2 className="h-[18px] w-[18px]" />
          </div>
          <CardTitle>Attendance health</CardTitle>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Last 30 days
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {projects.length === 0 ? (
          <EmptyState text="No attendance recorded in the last 30 days." />
        ) : (
          projects.map((p) => {
            const onTimeRate = p.total > 0 ? Math.round((p.onTime / p.total) * 100) : 0
            return (
              <div
                key={p.project}
                className="rounded-2xl border border-border/60 bg-surface-low p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-sm font-bold">{p.project}</p>
                  <p className="font-headline text-base font-extrabold text-foreground">
                    {onTimeRate}%
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.onTime} on time · {p.late} late · {p.missing} missing · {p.onLeave} on
                  leave
                </p>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

// ─── Card 3: Slow OT approvers ───────────────────────────────────────────────

function SlowOtApproversCard({ approvers }: { approvers: SlowOtApprover[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-tertiary/10 p-2.5 text-tertiary">
            <TimerReset className="h-[18px] w-[18px]" />
          </div>
          <CardTitle>Slow OT approvers</CardTitle>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          &gt; 24h average
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {approvers.length === 0 ? (
          <EmptyState text="All supervisors are reviewing OT requests within 24 hours." />
        ) : (
          approvers.map((a) => (
            <div
              key={a.reviewerId}
              className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-surface-low p-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{a.reviewerName}</p>
                <p className="text-xs text-muted-foreground">
                  {a.reviewedCount} reviewed · {a.pendingCount} pending
                </p>
              </div>
              <div className="text-right">
                <p className="font-headline text-base font-extrabold text-tertiary">
                  {a.averageHours.toFixed(1)}h
                </p>
                <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  avg
                </p>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// ─── Card 4: Stale pending claims ────────────────────────────────────────────

function StalePendingClaimsCard({ claims }: { claims: StalePendingClaim[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-tertiary/10 p-2.5 text-tertiary">
            <Clock className="h-[18px] w-[18px]" />
          </div>
          <CardTitle>Stale pending claims</CardTitle>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          &gt; 7 days
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {claims.length === 0 ? (
          <EmptyState text="No claims have been pending for more than 7 days." />
        ) : (
          claims.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-surface-low p-4"
            >
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                  {c.claimNumber}
                </p>
                <p className="truncate text-sm font-bold">{c.title}</p>
                <p className="text-xs text-muted-foreground">{c.employeeName}</p>
              </div>
              <div className="text-right">
                <p className="font-headline text-base font-extrabold text-foreground">
                  {formatCurrency(c.amount)}
                </p>
                <p className="text-[11px] font-semibold text-tertiary">
                  {c.daysPending}d pending
                </p>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// ─── Card 5: Upcoming claim run ──────────────────────────────────────────────

function UpcomingClaimRunCard({ run }: { run: UpcomingClaimRun | null }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <CalendarClock className="h-[18px] w-[18px]" />
          </div>
          <CardTitle>Upcoming claim run</CardTitle>
        </div>
        {run ? (
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {run.daysUntilCutoff === 0
              ? "Cutoff today"
              : `${run.daysUntilCutoff} day${run.daysUntilCutoff === 1 ? "" : "s"} left`}
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        {!run ? (
          <EmptyState text="Configure a claim cutoff in Settings to see this." />
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/60 bg-surface-low p-4">
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Cuts off
              </p>
              <p className="mt-1 font-headline text-2xl font-extrabold">
                {formatShortDate(run.cutoffDate)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Day {run.cutoffDay} of the month
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Claims" value={String(run.claimsInRun)} />
              <Stat label="Pending" value={String(run.pendingInRun)} tone="text-tertiary" />
              <Stat
                label="Queued value"
                value={formatCurrency(run.totalAmountInRun)}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Card 6: Failed Xero syncs ───────────────────────────────────────────────

function FailedXeroSyncsCard({
  total,
  samples,
}: {
  total: number
  samples: AdminExecutiveOverview["failedXeroSyncs"]["samples"]
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-destructive/10 p-2.5 text-destructive">
            <AlertTriangle className="h-[18px] w-[18px]" />
          </div>
          <CardTitle>Failed Xero syncs</CardTitle>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {total} total
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {samples.length === 0 ? (
          <EmptyState text="All claims are syncing cleanly to Xero." />
        ) : (
          samples.map((s) => (
            <div
              key={s.id}
              className="rounded-2xl border border-destructive/20 bg-destructive/5 p-4"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                    {s.claimNumber}
                  </p>
                  <p className="truncate text-sm font-bold">{s.title}</p>
                  <p className="text-xs text-muted-foreground">{s.employeeName}</p>
                </div>
                <p className="font-headline text-base font-extrabold text-foreground">
                  {formatCurrency(s.amount)}
                </p>
              </div>
              {s.errorMessage ? (
                <p className="mt-2 line-clamp-2 text-xs text-destructive">{s.errorMessage}</p>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
      {text}
    </p>
  )
}

function Stat({
  label,
  value,
  tone = "text-foreground",
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-surface-low p-4">
      <p className={`font-headline text-2xl font-extrabold ${tone}`}>{value}</p>
      <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
    </div>
  )
}
