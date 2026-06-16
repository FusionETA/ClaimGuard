import { MapPin } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CoordsLink } from "@/components/attendance/coords-link"
import {
  TableFilterBar,
  type TableFilterValue,
} from "@/components/attendance/table-filter-bar"

export type OffSiteRow = {
  id: string
  employeeId: string
  employeeName: string
  project: string | null
  timeIn: string | null
  clockInLat: number | null
  clockInLng: number | null
  clockInDistanceMeters: number
  notes: string | null
}

type FilterBarProps = {
  prefix: string
  projects: { id: string; name: string }[]
  teams: { id: string; name: string; projectName: string }[]
  value: TableFilterValue
}

function fmtTime(iso: string | null, tz: string): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleTimeString("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  })
}

export function OffSiteLogCard({
  rows,
  timezone,
  filterBar,
}: {
  rows: OffSiteRow[]
  timezone: string
  filterBar?: FilterBarProps
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-destructive/10 p-2.5 text-destructive">
            <MapPin className="h-[18px] w-[18px]" />
          </span>
          <div>
            <CardTitle>Off-site clock-ins</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Employees who clocked in outside the project geofence today.
            </p>
          </div>
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {rows.length}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {filterBar ? (
          <TableFilterBar
            prefix={filterBar.prefix}
            projects={filterBar.projects}
            teams={filterBar.teams}
            value={filterBar.value}
          />
        ) : null}
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
            No off-site clock-ins today.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              return (
                <div
                  key={r.id}
                  className="rounded-2xl border border-border/60 bg-surface-low px-4 py-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-bold">{r.employeeName}</p>
                    <span className="shrink-0 text-xs font-semibold text-destructive">
                      {Math.round(r.clockInDistanceMeters)}m from site
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[r.project, fmtTime(r.timeIn, timezone)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="mt-1">
                    <CoordsLink lat={r.clockInLat} lng={r.clockInLng} />
                  </div>
                  {r.notes ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {r.notes}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
