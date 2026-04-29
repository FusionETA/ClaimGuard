import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { requirePortalSession } from "@/lib/auth/session"
import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { attendanceStatusMeta } from "@/modules/attendance/domain/metadata"
import { cn } from "@/lib/utils"

const VARIANT: Record<string, string> = {
  ON_TIME: "on-time",
  LATE: "late",
  MISSING: "missing",
  ON_LEAVE: "on-leave",
  CLOCKED_IN: "clocked-in",
  CLOCKED_OUT: "clocked-out",
}

export default async function EmployeeHistoryPage() {
  const session = await requirePortalSession("EMPLOYEE")
  const now = new Date()
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const records = await employeeAttendanceService.getEmployeeHistory(
    session.userId,
    monthAgo,
    now,
  )

  return (
    <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Last 30 days
          </p>
          <h2 className="mt-0.5 text-xl font-bold text-foreground">Attendance history</h2>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-3">
              {records.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border-l-4 bg-card px-4 py-3",
                    r.status === "ON_TIME"
                      ? "border-l-success"
                      : r.status === "LATE"
                        ? "border-l-tertiary"
                        : "border-l-destructive",
                  )}
                >
                  {r.status === "MISSING" ? (
                    <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                  ) : (
                    <CheckCircle2
                      className={cn(
                        "h-5 w-5 shrink-0",
                        r.status === "ON_TIME" ? "text-success" : "text-tertiary",
                      )}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {r.date}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.timeIn} {r.timeOut ? `– ${r.timeOut}` : ""} • {r.location}
                    </p>
                  </div>
                  <Badge variant={VARIANT[r.status] as never}>
                    {attendanceStatusMeta[r.status].label}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
    </div>
  )
}
