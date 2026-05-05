"use client"

import { useMemo, useState, useTransition } from "react"

import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"
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
  buckets: HoursBuckets
}

export type HoursSummaryData = {
  totals: HoursBuckets
  employees: HoursSummaryEmployeeRow[]
}

type LoadAction = (fromIso: string, toIso: string) => Promise<HoursSummaryData>

type Props = {
  title?: string
  initialFrom: string
  initialTo: string
  initialData: HoursSummaryData
  loadAction: LoadAction
  showEmployeeTable?: boolean
}

const BUCKET_META: Array<{
  key: keyof HoursBuckets
  label: string
  tone: string
}> = [
  { key: "normalMin", label: "Normal", tone: "text-foreground" },
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
}: Props) {
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [data, setData] = useState<HoursSummaryData>(initialData)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

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
              Hours bucketed by Normal / OT / Rest day / Public holiday for the
              selected range.
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

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <BucketTotals totals={data.totals} />

        {showEmployeeTable ? (
          <EmployeeTable employees={sortedEmployees} />
        ) : null}
      </CardContent>
    </Card>
  )
}

function BucketTotals({ totals }: { totals: HoursBuckets }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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
        </div>
      ))}
      <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
          Total
        </p>
        <p className="mt-1 text-lg font-bold text-primary">
          {formatHm(totals.totalMin)}
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
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="py-2 pr-3 font-semibold">Employee</th>
            <th className="py-2 pr-3 text-right font-semibold">Normal</th>
            <th className="py-2 pr-3 text-right font-semibold">OT</th>
            <th className="py-2 pr-3 text-right font-semibold">Rest day</th>
            <th className="py-2 pr-3 text-right font-semibold">PH</th>
            <th className="py-2 pr-0 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((row) => {
            const isZero = row.buckets.totalMin === 0
            return (
              <tr
                key={row.employeeId}
                className={`border-b border-border/30 ${
                  isZero ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                <td className="py-2 pr-3">
                  <div className="font-medium">{row.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {row.email}
                  </div>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatHm(row.buckets.normalMin)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatHm(row.buckets.otMin)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatHm(row.buckets.restDayMin)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatHm(row.buckets.publicHolidayMin)}
                </td>
                <td className="py-2 pr-0 text-right font-semibold tabular-nums">
                  {formatHm(row.buckets.totalMin)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export { EMPTY_BUCKETS }
