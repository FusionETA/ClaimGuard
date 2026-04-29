import Link from "next/link"
import { ClipboardCheck, Clock, UmbrellaOff, Users } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { cn } from "@/lib/utils"

const barData = [
  { day: "MON", pct: 90 },
  { day: "TUE", pct: 85 },
  { day: "WED", pct: 95 },
  { day: "THU", pct: 88 },
  { day: "FRI", pct: 96 },
]

const liveActivity = [
  { name: "Jane Doe", time: "08:45 AM", status: "on-time" as const },
  { name: "Marcus Smith", time: "09:12 AM", status: "late" as const },
]

export default async function TeamOverviewPage() {
  const session = await requirePortalSession("SUPERVISOR")
  const overview = await supervisorAttendanceService.getTeamOverview(session.userId)

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
          { label: "On Leave", value: overview.onLeaveToday, icon: UmbrellaOff, color: "text-muted-foreground" },
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
            Attendance Rate
          </p>
          <p className="font-headline text-xl font-extrabold text-foreground">94%</p>
          <div className="mt-3 flex h-12 items-end gap-1">
            {barData.map((b) => (
              <div key={b.day} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full overflow-hidden rounded-sm bg-secondary"
                  style={{ height: "36px" }}
                >
                  <div
                    className="w-full rounded-sm bg-primary"
                    style={{ height: `${b.pct}%`, marginTop: `${100 - b.pct}%` }}
                  />
                </div>
                <span className="text-[8px] font-bold text-muted-foreground">{b.day}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <p className="mb-3 text-sm font-bold text-foreground">Live Activity</p>
          {liveActivity.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border/50 py-2.5 last:border-0"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-bold text-secondary-foreground">
                {a.name[0]}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground">Clocked In {a.time}</p>
              </div>
              <Badge variant={a.status}>{a.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <p className="mb-3 text-sm font-bold text-foreground">Team directory</p>
          <div className="space-y-2">
            {overview.team.map((m) => (
              <div
                key={m.employeeId}
                className="flex items-center gap-3 border-b border-border/50 py-2 last:border-0"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
                  {m.initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">{m.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {m.today
                      ? `${m.today.timeIn ?? "—"} • ${m.today.location ?? "—"}`
                      : "No clock-in yet today"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
