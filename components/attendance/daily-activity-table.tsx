import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export type DailyActivityRow = {
  id: string
  name: string
  jobTitle: string | null
  project: string | null
  timeIn: string | null
  timeOut: string | null
  status: string | null
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "long" }

function formatTime(iso: string | null, tz: string): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString("en-MY", { ...TIME_FORMAT, timeZone: tz })
}

export function DailyActivityTable({
  rows,
  timezone,
}: {
  rows: DailyActivityRow[]
  timezone: string
}) {
  const todayLabel = new Intl.DateTimeFormat("en-MY", {
    ...DATE_FORMAT,
    timeZone: timezone,
  }).format(new Date())

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle>Daily activity</CardTitle>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {todayLabel}
        </span>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
            No employees yet.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="hidden grid-cols-[2fr_2fr_1fr_1fr] gap-3 px-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:grid">
              <span>Employee</span>
              <span>Project / Job</span>
              <span>Clock in</span>
              <span>Clock out</span>
            </div>
            {rows.map((row) => {
              const inLabel = formatTime(row.timeIn, timezone)
              const outLabel = formatTime(row.timeOut, timezone)
              const meta =
                [row.project, row.jobTitle].filter(Boolean).join(" · ") || "—"
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-1 gap-1 rounded-2xl border border-border/60 bg-surface-low px-4 py-3 sm:grid-cols-[2fr_2fr_1fr_1fr] sm:items-center sm:gap-3"
                >
                  <p className="truncate text-sm font-bold">{row.name}</p>
                  <p className="truncate text-xs text-muted-foreground sm:text-sm">
                    {meta}
                  </p>
                  <p className="text-sm">
                    <span className="sm:hidden text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Clock in:{" "}
                    </span>
                    {inLabel ?? <span className="text-muted-foreground">—</span>}
                  </p>
                  <p className="text-sm">
                    <span className="sm:hidden text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Clock out:{" "}
                    </span>
                    {outLabel ? (
                      outLabel
                    ) : inLabel ? (
                      <span className="italic text-muted-foreground">
                        Still working
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
