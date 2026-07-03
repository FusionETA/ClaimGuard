"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"
import {
  EMPTY_BUCKETS,
  formatHm,
  type HoursBuckets,
} from "@/modules/attendance/domain/hours-summary"

export type HoursSummaryEmployeeRow = {
  employeeId: string
  name: string
  email: string
  initials: string
  /// False when the employee's policy has `otEnabled: false`. OT / Rest
  /// day / PH columns render as "—" for these rows (and their minutes
  /// are already folded into `normalMin` server-side).
  otEnabled?: boolean
  buckets: HoursBuckets & { expectedMin?: number }
}

export type HoursSummaryData = {
  totals: HoursBuckets & { expectedMin?: number }
  employees: HoursSummaryEmployeeRow[]
}

type LoadAction = (fromIso: string, toIso: string) => Promise<HoursSummaryData>

type FilterBarProps = {
  prefix: string
  projects: { id: string; name: string }[]
  teams: { id: string; name: string; projectName: string }[]
  value: TableFilterValue
}

type Props = {
  title?: string
  initialFrom: string
  initialTo: string
  initialData: HoursSummaryData
  loadAction: LoadAction
  showEmployeeTable?: boolean
  /// When false, hide the 6-column bucket totals grid at the top of the
  /// panel. The per-employee table below still renders.
  showTotals?: boolean
  filterBar?: FilterBarProps
}

// Bucket cards shown across the top of the panel. "Normal" was
// removed intentionally — it duplicated the "Clock in hours" roll-up
// below and admins found the two side-by-side confusing (both are
// derived from the same data — the roll-up already tells the story).
const BUCKET_META: Array<{
  key: keyof HoursBuckets
  label: string
  tone: string
}> = [
  { key: "otMin", label: "Overtime", tone: "text-amber-600" },
  { key: "restDayMin", label: "Rest day", tone: "text-blue-600" },
  { key: "publicHolidayMin", label: "Public holiday", tone: "text-purple-600" },
]

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  return d.toISOString().slice(0, 10)
}

export function defaultRange(): { from: string; to: string } {
  return { from: startOfMonthIso(), to: todayIso() }
}

export function HoursSummaryPanel({
  title = "Working hours summary",
  initialFrom,
  initialTo,
  initialData,
  loadAction,
  showEmployeeTable = false,
  showTotals = true,
  filterBar,
}: Props) {
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [data, setData] = useState<HoursSummaryData>(initialData)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Mirror server-supplied data whenever the parent re-renders with a
  // new payload (e.g. after an active-company switch). Without this,
  // useState(initialData) only takes effect on first mount.
  useEffect(() => {
    setData(initialData)
  }, [initialData])

  const sortedEmployees = useMemo(
    () =>
      [...data.employees].sort(
        (a, b) => b.buckets.totalMin - a.buckets.totalMin || a.name.localeCompare(b.name),
      ),
    [data.employees],
  )

  const handleApply = () => {
    setError(null)
    if (!from || !to) {
      setError("Pick both a start and end date")
      return
    }
    if (from > to) {
      setError("Start date must be on or before end date")
      return
    }
    startTransition(async () => {
      try {
        const next = await loadAction(from, to)
        setData(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load summary")
      }
    })
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-headline text-lg font-semibold text-foreground">
              {title}
            </h3>
            <p className="text-xs text-muted-foreground">
              Normal hours are the worked total. OT, Rest day, and Public
              holiday are tracked separately and do not count toward expected
              working hours.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="hs-from" className="text-[10px] uppercase tracking-wider">
                From
              </Label>
              <Input
                id="hs-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
            <div>
              <Label htmlFor="hs-to" className="text-[10px] uppercase tracking-wider">
                To
              </Label>
              <Input
                id="hs-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleApply}
              disabled={pending}
            >
              {pending ? "Loading…" : "Apply"}
            </Button>
          </div>
        </div>

        {filterBar ? (
          <TableFilterBar
            prefix={filterBar.prefix}
            projects={filterBar.projects}
            teams={filterBar.teams}
            value={filterBar.value}
          />
        ) : null}

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {showTotals ? <BucketTotals totals={data.totals} /> : null}

        {showEmployeeTable ? (
          <EmployeeTable employees={sortedEmployees} />
        ) : null}
      </CardContent>
    </Card>
  )
}

/// Tiny inline breakdown shown under the OT totals: "✓ 4h · ⏳ 1h · ✗ 0h".
/// Only renders non-zero buckets so a clean Approved-only state still
/// looks clean. A trailing "+ Xh unassigned" appears when some OT
/// minutes have no matching ApprovalRequest (legacy rows where the
/// auto-create never ran).
function OtStatusBreakdown({
  approvedMin,
  pendingMin,
  rejectedMin,
  totalMin,
}: {
  approvedMin: number
  pendingMin: number
  rejectedMin: number
  totalMin: number
}) {
  const unassigned = Math.max(0, totalMin - approvedMin - pendingMin - rejectedMin)
  const parts: Array<{ label: string; value: number; cls: string }> = []
  if (approvedMin > 0) parts.push({ label: "Approved", value: approvedMin, cls: "text-emerald-600" })
  if (pendingMin > 0) parts.push({ label: "Pending", value: pendingMin, cls: "text-amber-600" })
  if (rejectedMin > 0) parts.push({ label: "Rejected", value: rejectedMin, cls: "text-destructive" })
  if (unassigned > 0) parts.push({ label: "Unassigned", value: unassigned, cls: "text-muted-foreground" })
  if (parts.length === 0) return null
  return (
    <p className="mt-1 text-[10px] font-medium leading-snug">
      {parts.map((p, i) => (
        <span key={p.label}>
          <span className={p.cls}>
            {p.label} {formatHm(p.value)}
          </span>
          {i < parts.length - 1 ? (
            <span className="px-1 text-muted-foreground/60">·</span>
          ) : null}
        </span>
      ))}
    </p>
  )
}

function BucketTotals({
  totals,
}: {
  totals: HoursBuckets & { expectedMin?: number }
}) {
  const expectedMin = totals.expectedMin ?? 0
  // Grid now holds 5 cards: 3 buckets (OT/Rest/PH) + Clock in hours +
  // Expected. Dropped the old 7-slot layout since we removed the two
  // "Normal"-flavour cards ("Normal" bucket + "Worked (Normal)"
  // shortfall card) — they duplicated the roll-up.
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {BUCKET_META.map((meta) => (
        <div
          key={meta.key}
          className="rounded-lg border border-border/60 bg-secondary/20 p-3"
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {meta.label}
          </p>
          <p className={`mt-1 text-lg font-bold ${meta.tone}`}>
            {formatHm(totals[meta.key])}
          </p>
          {meta.key === "otMin" && totals.otMin > 0 ? (
            <OtStatusBreakdown
              approvedMin={totals.otApprovedMin}
              pendingMin={totals.otPendingMin}
              rejectedMin={totals.otRejectedMin}
              totalMin={totals.otMin}
            />
          ) : null}
        </div>
      ))}
      {/* Roll-up: sum of Normal + OT + Rest day + Public holiday.
          Distinct primary tint so it reads as a "roll-up" rather than
          another category bucket. Renamed from "Total worked" to
          "Clock in hours" — matches what employees know they did. */}
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
          Clock in hours
        </p>
        <p className="mt-1 text-lg font-bold text-primary">
          {formatHm(totals.totalMin)}
        </p>
      </div>
      <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Expected
        </p>
        <p className="mt-1 text-lg font-bold text-muted-foreground">
          {formatHm(expectedMin)}
        </p>
      </div>
    </div>
  )
}

function EmployeeTable({ employees }: { employees: HoursSummaryEmployeeRow[] }) {
  if (employees.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No employees in scope for the selected range.
      </p>
    )
  }
  return (
    <ScrollArea className="max-h-[420px] overflow-auto rounded-md border border-border/40">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="bg-card py-2 pl-3 pr-3 font-semibold">Employee</th>
            {/* Renamed "Total" to "Clock in hours" — matches the roll-up
                card above and reads better for HR (no ambiguity with the
                per-bucket columns). "Normal" column removed with the
                bucket cards; the value is still folded into the roll-up. */}
            <th className="bg-card py-2 pr-3 text-right font-semibold">Clock in hours</th>
            <th className="bg-card py-2 pr-3 text-right font-semibold">Expected</th>
            <th className="bg-card py-2 pr-3 text-right font-semibold">OT</th>
            <th className="bg-card py-2 pr-3 text-right font-semibold">Rest day</th>
            <th className="bg-card py-2 pr-3 text-right font-semibold">PH</th>
            <th className="bg-card py-2 pr-3 text-right font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((row) => {
            const expectedMin = row.buckets.expectedMin ?? 0
            // Still needed for the Status column badge — shortfall
            // means clocked-normal-hours < expected. Column
            // (Normal) was removed, but the derived status pill
            // stays visible.
            const shortfall =
              expectedMin > 0 && row.buckets.normalMin < expectedMin
            const isZero = row.buckets.totalMin === 0
            return (
              <tr
                key={row.employeeId}
                className={`border-b border-border/30 ${
                  isZero ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                <td className="py-2 pl-3 pr-3">
                  <div className="font-medium">{row.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {row.email}
                  </div>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-semibold text-primary">
                  {formatHm(row.buckets.totalMin)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                  {expectedMin > 0 ? formatHm(expectedMin) : "—"}
                </td>
                {/* OT / Rest day / PH columns render "—" for employees
                    whose policy disables OT — those categories don't
                    apply and the minutes are already folded into Normal. */}
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.otEnabled === false ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      {formatHm(row.buckets.otMin)}
                      {row.buckets.otMin > 0 ? (
                        <OtStatusBreakdown
                          approvedMin={row.buckets.otApprovedMin}
                          pendingMin={row.buckets.otPendingMin}
                          rejectedMin={row.buckets.otRejectedMin}
                          totalMin={row.buckets.otMin}
                        />
                      ) : null}
                    </>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.otEnabled === false ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatHm(row.buckets.restDayMin)
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.otEnabled === false ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatHm(row.buckets.publicHolidayMin)
                  )}
                </td>
                <td className="py-2 pr-3 text-right">
                  {shortfall ? (
                    <Badge variant="late">Shortfall</Badge>
                  ) : expectedMin > 0 ? (
                    <Badge variant="approved">On target</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </ScrollArea>
  )
}

export { EMPTY_BUCKETS }
