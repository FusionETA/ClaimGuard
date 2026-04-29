import Link from "next/link"

import { Avatar, AvatarFallback } from "@/components/attendance/ui/avatar"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

export default async function SupervisorTeamPage() {
  const session = await requirePortalSession("SUPERVISOR")
  const overview = await supervisorAttendanceService.getTeamOverview(session.userId)

  return (
    <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {overview.teamSize} members
          </p>
          <h2 className="mt-0.5 text-xl font-bold text-foreground">Team directory</h2>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-3">
              {overview.team.map((m) => (
                <Link
                  key={m.employeeId}
                  href={`/supervisor/attendance/employee/${m.employeeId}`}
                  className="flex items-center gap-3 rounded-xl border border-transparent p-2 transition hover:border-border/60 hover:bg-secondary/30"
                >
                  <Avatar className="h-10 w-10">
                    <AvatarFallback>{m.initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{m.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.today
                        ? `${m.today.timeIn ?? "—"} • ${m.today.location ?? "—"}`
                        : "No clock-in yet today"}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
    </div>
  )
}
