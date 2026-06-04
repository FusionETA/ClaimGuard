"use client"

import { useMemo, useState } from "react"
import { ChevronDown, Search } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import type { EmployeeLeaveBalances } from "@/modules/leave/application/services/leave-entitlements.service"
import { cn, formatDays } from "@/lib/utils"

type Props = {
  /// All employees in scope (org-wide for admin; direct reports only for
  /// supervisor). Pre-sorted by name from the service.
  employees: EmployeeLeaveBalances[]
  year: number
  /// Optional: an explanatory empty-state message shown when `employees`
  /// is []. Supervisor view uses this to say "you don't have any direct
  /// reports" rather than the generic "no results".
  emptyHint?: string
  /// Show the per-employee Default/Policy/Custom pill next to each
  /// name. Admin-only — supervisors don't need to see leave
  /// configuration sources at this level.
  showSource?: boolean
}

/// Collapsible card for one employee. Header is the click target —
/// shows name + role + a short summary (number of types, plus a
/// red/amber pill if any balance is low or fully used so admins can
/// scan for at-risk employees without expanding every row). Body
/// (the balance grid) only mounts when expanded, so the page loads
/// quickly on orgs with many employees.
function EmployeeBalancesCard({
  employee,
  showSource,
}: {
  employee: EmployeeLeaveBalances
  /// Admin-only: render the Default/Policy/Custom pill next to the
  /// employee name.
  showSource?: boolean
}) {
  const [open, setOpen] = useState(false)

  // Count "low" (< 25% remaining) and "out" (zero available)
  // balances so the collapsed header surfaces at-risk employees.
  let lowCount = 0
  let outCount = 0
  for (const b of employee.balances) {
    if (b.entitledDays <= 0) continue
    if (b.availableDays === 0) outCount += 1
    else if (b.availableDays / b.entitledDays < 0.25) lowCount += 1
  }

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-[28px]"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-bold text-foreground">
              {employee.name}
            </span>
            {employee.role === "SUPERVISOR" ? (
              <Badge variant="outline" className="text-[10px]">
                Supervisor
              </Badge>
            ) : null}
            {showSource ? (
              <Badge
                variant={
                  employee.leaveSource === "custom" ? "default" : "outline"
                }
                className={
                  "text-[10px] " +
                  (employee.leaveSource === "default"
                    ? "text-muted-foreground"
                    : "")
                }
                title={
                  employee.leaveSource === "custom"
                    ? "Has at least one per-employee leave override."
                    : employee.leaveSource === "policy"
                      ? "Inherits from their policy. No per-employee overrides."
                      : "Inherits type defaults. No policy or employee overrides."
                }
              >
                {employee.leaveSource === "custom"
                  ? "Custom"
                  : employee.leaveSource === "policy"
                    ? "Policy"
                    : "Default"}
              </Badge>
            ) : null}
            {outCount > 0 ? (
              <Badge variant="rejected" className="text-[10px]">
                {outCount} out
              </Badge>
            ) : null}
            {lowCount > 0 ? (
              <Badge variant="pending" className="text-[10px]">
                {lowCount} low
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {employee.jobTitle}
            {employee.jobTitle ? " · " : ""}
            {employee.email}
            {" · "}
            {employee.balances.length} leave type
            {employee.balances.length === 1 ? "" : "s"}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-5 w-5 shrink-0 text-muted-foreground transition-transform mt-0.5",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <CardContent className="px-4 pb-4 pt-0">
          {employee.balances.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No leave types configured for this employee.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {employee.balances.map((b) => {
                const low =
                  b.entitledDays > 0 &&
                  b.availableDays / b.entitledDays < 0.25
                const usedAll =
                  b.entitledDays > 0 && b.availableDays === 0
                return (
                  <div
                    key={b.id}
                    className={cn(
                      "rounded-lg border bg-surface-low/40 p-2.5",
                      usedAll
                        ? "border-destructive/40 bg-destructive/5"
                        : low
                          ? "border-amber-300/60 bg-amber-50/60"
                          : "border-border/60",
                    )}
                  >
                    <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {b.leaveTypeName}
                    </p>
                    <p className="mt-0.5 text-base font-bold tabular-nums text-foreground">
                      {b.paid
                        ? formatDays(b.availableDays)
                        : formatDays(b.usedDays)}
                      <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                        {b.paid
                          ? `/ ${formatDays(b.entitledDays + b.carriedDays)} avail`
                          : "used"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                      entitled {formatDays(b.entitledDays)}
                      {b.carriedDays > 0
                        ? ` · carried ${formatDays(b.carriedDays)}`
                        : ""}
                      {b.usedDays > 0 && b.paid
                        ? ` · used ${formatDays(b.usedDays)}`
                        : ""}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

export function LeaveBalancesGrid({ employees, year, emptyHint, showSource }: Props) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.email.toLowerCase().includes(q) ||
        e.jobTitle.toLowerCase().includes(q),
    )
  }, [employees, query])

  if (employees.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="text-sm font-semibold text-foreground">
            No employees in scope
          </p>
          {emptyHint ? (
            <p className="mt-1 text-xs text-muted-foreground">{emptyHint}</p>
          ) : null}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or job title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {filtered.length === employees.length
            ? `${employees.length} employees`
            : `${filtered.length} of ${employees.length}`}
          {" · "}Year {year}
        </p>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No employees match &ldquo;{query}&rdquo;.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((emp) => (
            <EmployeeBalancesCard
              key={emp.userId}
              employee={emp}
              showSource={showSource}
            />
          ))}
        </div>
      )}
    </div>
  )
}
