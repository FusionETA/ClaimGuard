"use client"

import { useMemo, useState } from "react"
import { ChevronDown, Search } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { EmployeeLeaveBalances } from "@/modules/leave/application/services/leave-entitlements.service"
import { cn, formatDays } from "@/lib/utils"

const PAGE_SIZE = 10

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
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">
              {employee.name}
            </span>
            {employee.role === "SUPERVISOR" ? (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                Supervisor
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
        {/* Right-aligned meta: at-risk badges, source pill, chevron. */}
        <div className="flex shrink-0 items-center gap-2">
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
          {showSource ? (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide",
                employee.leaveSource === "default" &&
                  "border-emerald-300 bg-emerald-50 text-emerald-700",
                employee.leaveSource === "policy" &&
                  "border-sky-300 bg-sky-50 text-sky-700",
                employee.leaveSource === "custom" &&
                  "border-rose-300 bg-rose-50 text-rose-700",
              )}
              title={
                employee.leaveSource === "custom"
                  ? "Has at least one per-employee leave override (entitled days or accrual method)."
                  : employee.leaveSource === "policy"
                    ? "Follows the employee's policy. Their policy has at least one leave-type override."
                    : "Follows the leave type defaults. No policy or per-employee overrides apply."
              }
            >
              {employee.leaveSource === "custom"
                ? "Custom"
                : employee.leaveSource === "policy"
                  ? "Policy"
                  : "Default"}
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              "h-5 w-5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-0">
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
        </div>
      )}
    </div>
  )
}

export function LeaveBalancesGrid({ employees, year, emptyHint, showSource }: Props) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)

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

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  // Clamp in case the result set shrank (e.g. after a search) below the
  // current page — keeps the slice valid without an effect.
  const safePage = Math.min(page, totalPages)
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

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
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
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
        <>
          <Card className="overflow-hidden">
            <div className="divide-y divide-border/60">
              {pageItems.map((emp) => (
                <EmployeeBalancesCard
                  key={emp.userId}
                  employee={emp}
                  showSource={showSource}
                />
              ))}
            </div>
          </Card>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-xs text-muted-foreground tabular-nums">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, filtered.length)} of{" "}
                {filtered.length}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                  Page {safePage} of {totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
