import { Badge } from "@/components/attendance/ui/badge"
import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"
import { otTypeMeta } from "@/modules/attendance/domain/metadata"

export default async function ApprovalsPage() {
  const session = await requirePortalSession("SUPERVISOR")
  const pending =
    await supervisorAttendanceService.getPendingApprovalsForSupervisor(session.userId)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {pending.length} pending
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-foreground">Approvals queue</h2>
      </div>

      <div className="space-y-3">
        {pending.map((r) => (
          <Card key={r.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="overtime">{otTypeMeta[r.type].label}</Badge>
                    <span className="text-xs font-semibold text-muted-foreground">
                      {r.date}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-bold text-foreground">
                    {r.employeeName ?? r.employeeId}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-foreground">{r.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" className="flex-1">
                  Approve
                </Button>
                <Button size="sm" variant="outline" className="flex-1">
                  Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
