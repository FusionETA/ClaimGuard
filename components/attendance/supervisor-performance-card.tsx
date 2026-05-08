import { AlertTriangle, ThumbsDown } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export type SupervisorPerformanceRow = {
  reviewerId: string
  reviewerName: string
  totalDecisions: number
  approvedCount: number
  rejectedCount: number
  slowApprovalCount: number
  avgDelayMinutes: number | null
  maxDelayMinutes: number | null
}

function fmtDelay(min: number | null): string {
  if (min == null) return "—"
  if (Math.abs(min) < 60) return `${min}m`
  const h = Math.floor(Math.abs(min) / 60)
  const m = Math.abs(min) % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function SupervisorPerformanceCard({
  rows,
  slaMinutes,
}: {
  rows: SupervisorPerformanceRow[]
  slaMinutes: number
}) {
  const slow = rows
    .filter((r) => r.slowApprovalCount > 0)
    .sort((a, b) => b.slowApprovalCount - a.slowApprovalCount)
  const rejecters = rows
    .filter((r) => r.rejectedCount > 0)
    .sort((a, b) => b.rejectedCount - a.rejectedCount)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div>
          <CardTitle>Supervisor performance</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Slow approvals exceed {slaMinutes} min from event to review.
            Rejections are any rejected approval in the selected range.
          </p>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {rows.length} supervisor{rows.length === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <PerformanceList
          title="Slow approvals"
          subtitle={`> ${slaMinutes} min`}
          icon={<AlertTriangle className="h-4 w-4" />}
          accent="bg-tertiary/10 text-tertiary"
          empty="Every supervisor reviewed within the SLA."
          rows={slow}
          render={(r) => (
            <span className="text-xs font-semibold text-tertiary">
              {r.slowApprovalCount} slow · max {fmtDelay(r.maxDelayMinutes)}
            </span>
          )}
        />
        <PerformanceList
          title="Frequent rejecters"
          subtitle="Any rejection"
          icon={<ThumbsDown className="h-4 w-4" />}
          accent="bg-destructive/10 text-destructive"
          empty="No rejections in this range."
          rows={rejecters}
          render={(r) => {
            const rate =
              r.totalDecisions > 0
                ? Math.round((r.rejectedCount / r.totalDecisions) * 100)
                : 0
            return (
              <span className="text-xs font-semibold text-destructive">
                {r.rejectedCount} rejected · {rate}%
              </span>
            )
          }}
        />
      </CardContent>
    </Card>
  )
}

function PerformanceList({
  title,
  subtitle,
  icon,
  accent,
  empty,
  rows,
  render,
}: {
  title: string
  subtitle: string
  icon: React.ReactNode
  accent: string
  empty: string
  rows: SupervisorPerformanceRow[]
  render: (row: SupervisorPerformanceRow) => React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`rounded-xl p-1.5 ${accent}`}>{icon}</span>
        <p className="text-sm font-semibold">{title}</p>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {subtitle}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        rows.map((r) => (
          <div
            key={r.reviewerId}
            className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-surface-low px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{r.reviewerName}</p>
              <p className="text-xs text-muted-foreground">
                {r.totalDecisions} decision{r.totalDecisions === 1 ? "" : "s"} · avg{" "}
                {fmtDelay(r.avgDelayMinutes)}
              </p>
            </div>
            {render(r)}
          </div>
        ))
      )}
    </div>
  )
}
