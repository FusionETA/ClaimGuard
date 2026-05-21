import Link from "next/link"
import type { Route } from "next"
import {
  Banknote,
  CalendarDays,
  CalendarClock,
  ChevronRight,
  Receipt,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { AdminQuickActionCounts } from "@/modules/claims/application/services/admin-quick-actions.service"

type QuickAction = {
  href: Route
  label: string
  hint: string
  icon: typeof Receipt
  /// Live count; when > 0 a badge is shown. undefined = no badge.
  count?: number
}

/**
 * Shortcut row pinned at the top of the executive overview. The
 * actionable items carry a live badge so the page doubles as a
 * "what needs me" cue.
 */
export function QuickActionsCard({ counts }: { counts: AdminQuickActionCounts }) {
  const actions: QuickAction[] = [
    {
      href: "/admin/claims" as Route,
      label: "Review claims",
      hint: "Approval queue",
      icon: Receipt,
      count: counts.pendingClaims,
    },
    {
      href: "/admin/payroll/runs" as Route,
      label: "Run payroll",
      hint: "Draft runs",
      icon: Banknote,
      count: counts.draftPayrollRuns,
    },
    {
      href: "/admin/hierarchy" as Route,
      label: "Manage employees",
      hint: "Add & edit people",
      icon: Users,
      count: counts.employeesNeedingSetup,
    },
    {
      href: "/admin/leave" as Route,
      label: "Leave requests",
      hint: "Pending approvals",
      icon: CalendarDays,
      count: counts.pendingLeave,
    },
    {
      href: "/admin/attendance" as Route,
      label: "Attendance",
      hint: "Last 30 days",
      icon: CalendarClock,
    },
    {
      href: "/admin/settings?tab=policies" as Route,
      label: "Create policy",
      hint: "Employee policies",
      icon: ShieldCheck,
    },
  ]

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 pb-3">
        <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
          <Zap className="h-[18px] w-[18px]" />
        </div>
        <CardTitle>Quick actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {actions.map((action) => {
            const Icon = action.icon
            const showBadge = typeof action.count === "number" && action.count > 0
            return (
              <Link
                key={action.href}
                href={action.href}
                className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-surface-low p-4 transition hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="rounded-xl bg-background p-2 text-primary shadow-sm">
                  <Icon className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-foreground">
                    {action.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {action.hint}
                  </p>
                </div>
                {showBadge ? (
                  <span className="inline-flex min-w-[22px] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-bold text-primary-foreground">
                    {action.count}
                  </span>
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                )}
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
