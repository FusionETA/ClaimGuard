import { requirePortalSession } from "@/lib/auth/session"
import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { otStatusMeta, otTypeMeta } from "@/modules/attendance/domain/metadata"

const STATUS_VARIANT: Record<string, string> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  OFFSET: "offset",
  UNRESOLVED: "unresolved",
}

export default async function EmployeeOTPage() {
  const session = await requirePortalSession("EMPLOYEE")
  const records = await employeeAttendanceService.getEmployeeOTRecords(session.userId)

  return (
    <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            OT &amp; Replacements
          </p>
          <h2 className="mt-0.5 text-xl font-bold text-foreground">Your overtime ledger</h2>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Accumulated", value: "14h 42m" },
            { label: "Approved", value: "12.5h" },
            { label: "Pending", value: "2.2h" },
          ].map((s) => (
            <Card key={s.label} className="p-4 text-center">
              <p className="font-headline text-2xl font-extrabold text-foreground">
                {s.value}
              </p>
              <p className="text-[11px] font-semibold text-muted-foreground">{s.label}</p>
            </Card>
          ))}
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-3">
              {records.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start gap-3 border-b border-border/50 pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-foreground">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {otTypeMeta[r.type].label} • {r.date}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                  </div>
                  <Badge variant={STATUS_VARIANT[r.status] as never}>
                    {otStatusMeta[r.status].label}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
    </div>
  )
}
