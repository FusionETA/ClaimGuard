import Link from "next/link"
import { ChevronRight, ClipboardCheck, Clock, UmbrellaOff, Users } from "lucide-react"

import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { cn } from "@/lib/utils"

function fmtTime(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "—"
}

export default async function TeamOverviewPage() {
  const session = await requirePortalSession("SUPERVISOR")
  const overview = await supervisorAttendanceService.getTeamOverview(session.userId)

  const attendanceRate =
    overview.teamSize > 0
      ? Math.round((overview.presentToday / overview.teamSize) * 100)
      : 0

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Real-time
        </p>
        <h2 className="font-headline mt-0.5 text-xl font-bold text-foreground">
          {session.organizationName ?? "Your team"}
        </h2>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "In Office", value: overview.presentToday, icon: Users, color: "text-success" },
          { label: "Late", value: overview.lateToday, icon: Clock, color: "text-tertiary" },
          {
            label: "On Leave",
            value: overview.onLeaveToday,
            icon: UmbrellaOff,
            color: "text-muted-foreground",
          },
        ].map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.label} className="rounded-2xl p-3 text-center">
              <Icon className={cn("mx-auto h-5 w-5", s.color)} />
              <p className="font-headline mt-1 text-2xl font-extrabold text-foreground">
                {s.value}
              </p>
              <p className="text-[10px] font-semibold text-muted-foreground">{s.label}</p>
            </Card>
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="rounded-2xl bg-secondary/60 p-4">
          <ClipboardCheck className="h-5 w-5 text-primary" />
          <p className="font-headline mt-1 text-2xl font-extrabold text-primary">
            {String(overview.pendingApprovals).padStart(2, "0")}
          </p>
          <p className="mb-3 text-[11px] font-semibold text-muted-foreground">
            Pending Approvals
          </p>
          <Link href="/employee/attendance/approvals">
            <Button size="sm" className="w-full text-xs">
              Review All
            </Button>
          </Link>
        </Card>

        <Card className="rounded-2xl p-4">
          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">
            Attendance rate today
          </p>
          <p className="font-headline text-3xl font-extrabold text-foreground">
            {attendanceRate}%
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {overview.presentToday} of {overview.teamSize} present
          </p>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <p className="mb-3 text-sm font-bold text-foreground">Team directory</p>
          {overview.team.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No reports assigned. Add team members under{" "}
              <span className="font-semibold">Hierarchy</span> to see them here.
            </p>
          ) : (
            <div className="space-y-1">
              {overview.team.map((m) => (
                <Link
                  key={m.employeeId}
                  href={`/employee/attendance/team/${m.employeeId}`}
                  className="flex items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition hover:border-border/60 hover:bg-secondary/30"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
                    {m.initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{m.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.today
                        ? `${fmtTime(m.today.timeIn)} ${
                            m.today.location ? `• ${m.today.location}` : ""
                          }`
                        : "No clock-in yet today"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
