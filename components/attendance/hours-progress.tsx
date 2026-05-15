import { Card, CardContent } from "@/components/attendance/ui/card"

export type ProgressEntry = {
  actualMin: number
  expectedMin: number
}

type Props = {
  weekly: ProgressEntry
  monthly: ProgressEntry
  className?: string
}

function pct({ actualMin, expectedMin }: ProgressEntry): number {
  if (expectedMin <= 0) return 0
  return Math.min(100, Math.round((actualMin / expectedMin) * 100))
}

function toneFor(value: number): string {
  if (value >= 100) return "bg-emerald-500"
  if (value >= 75) return "bg-primary"
  if (value >= 40) return "bg-amber-500"
  return "bg-red-500"
}

/// Renders hours as a whole-number "26" when the minute remainder is
/// zero, or "26.5" with a single decimal otherwise. Keeps the headline
/// number readable without burying it under units.
function formatHoursValue(minutes: number): string {
  const safe = Math.max(0, minutes)
  const hours = safe / 60
  if (Number.isInteger(hours)) return String(hours)
  return (Math.round(hours * 10) / 10).toString()
}

function ProgressCard({
  label,
  entry,
}: {
  label: string
  entry: ProgressEntry
}) {
  const value = pct(entry)
  const actualStr = formatHoursValue(entry.actualMin)
  const expectedStr = formatHoursValue(entry.expectedMin)
  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <div className="flex items-baseline gap-1">
          <span className="font-headline text-3xl font-bold tabular-nums text-foreground">
            {actualStr}
          </span>
          <span className="text-lg font-semibold text-muted-foreground">
            /{expectedStr}
          </span>
          <span className="ml-1 text-xs text-muted-foreground">hours</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary/40">
          <div
            className={`h-full transition-all ${toneFor(value)}`}
            style={{ width: `${value}%` }}
          />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Two side-by-side cards showing weekly and monthly actual-vs-expected
 * working hours in the compact "26/40" format. Used on the employee
 * dashboard and admin/supervisor employee-detail pages.
 */
export function HoursProgress({ weekly, monthly, className }: Props) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 ${className ?? ""}`}>
      <ProgressCard label="This week" entry={weekly} />
      <ProgressCard label="This month" entry={monthly} />
    </div>
  )
}

/**
 * Compact inline variant for table cells — e.g. the admin employees
 * list "Hours (month)" column.
 */
export function HoursProgressInline({ entry }: { entry: ProgressEntry }) {
  const value = pct(entry)
  return (
    <span className="inline-flex flex-col items-end">
      <span className="text-sm font-medium tabular-nums text-foreground">
        {formatHoursValue(entry.actualMin)}
        <span className="text-muted-foreground">
          /{formatHoursValue(entry.expectedMin)}
        </span>
      </span>
      <span
        className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-secondary/40"
        aria-hidden="true"
      >
        <span
          className={`block h-full ${toneFor(value)}`}
          style={{ width: `${value}%` }}
        />
      </span>
    </span>
  )
}
