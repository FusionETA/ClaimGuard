import Link from "next/link"
import { Building2, ClipboardCheck, Clock, UmbrellaOff, Users } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

export default async function AdminAttendancePage() {
  await requirePortalSession("ADMIN")
  const overview = await adminAttendanceService.getOrgOverview()
  const stats = await adminAttendanceService.getAggregateStats(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    new Date(),
  )

  const presentRate = Math.round((overview.presentToday / overview.headcount) * 100)

  return (
    <div className="space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Organisation-wide
          </p>
          <h2 className="font-headline mt-0.5 text-2xl font-bold text-foreground">
            Attendance overview
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Headcount", value: overview.headcount, icon: Users, color: "text-primary" },
            { label: "Present", value: overview.presentToday, icon: Users, color: "text-success" },
            { label: "Late", value: overview.lateToday, icon: Clock, color: "text-tertiary" },
            { label: "On leave", value: overview.onLeaveToday, icon: UmbrellaOff, color: "text-muted-foreground" },
          ].map((s) => {
            const Icon = s.icon
            return (
              <Card key={s.label} className="p-4">
                <Icon className={`h-5 w-5 ${s.color}`} />
                <p className="font-headline mt-2 text-3xl font-extrabold text-foreground">
                  {s.value}
                </p>
                <p className="text-[11px] font-semibold text-muted-foreground">{s.label}</p>
              </Card>
            )
          })}
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="bg-secondary/60 p-4 lg:col-span-1">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            <p className="font-headline mt-1 text-3xl font-extrabold text-primary">
              {String(overview.pendingApprovals).padStart(2, "0")}
            </p>
            <p className="mb-3 text-[11px] font-semibold text-muted-foreground">
              Pending approvals (all teams)
            </p>
            <Link href="/admin/attendance/approvals">
              <Button size="sm" className="w-full text-xs">
                Review all
              </Button>
            </Link>
          </Card>

          <Card className="p-4 lg:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              30-day rolling
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div>
                <p className="font-headline text-2xl font-extrabold text-foreground">
                  {stats.totalAttendanceRecords.toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground">Records</p>
              </div>
              <div>
                <p className="font-headline text-2xl font-extrabold text-tertiary">
                  {stats.totalLate}
                </p>
                <p className="text-[11px] text-muted-foreground">Late instances</p>
              </div>
              <div>
                <p className="font-headline text-2xl font-extrabold text-destructive">
                  {stats.totalMissing}
                </p>
                <p className="text-[11px] text-muted-foreground">Missing</p>
              </div>
              <div>
                <p className="font-headline text-2xl font-extrabold text-accent">
                  {stats.totalOnLeave}
                </p>
                <p className="text-[11px] text-muted-foreground">Leave days</p>
              </div>
            </div>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-bold text-foreground">By project</p>
              <Badge variant="overtime">{presentRate}% present</Badge>
            </div>
            <div className="space-y-2">
              {overview.byProject.map((p) => {
                const rate = Math.round((p.presentToday / p.headcount) * 100)
                return (
                  <div
                    key={p.project}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3"
                  >
                    <Building2 className="h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {p.project}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.presentToday}/{p.headcount} present • {p.lateToday} late
                      </p>
                    </div>
                    <span className="text-xs font-bold text-muted-foreground">{rate}%</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
    </div>
  )
}
