import Link from "next/link"
import { ChevronRight } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/attendance/ui/avatar"
import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { requirePortalSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { attendanceStatusMeta } from "@/modules/attendance/domain/metadata"

const STATUS_VARIANT: Record<string, string> = {
  ON_TIME: "on-time",
  LATE: "late",
  MISSING: "missing",
  ON_LEAVE: "on-leave",
  CLOCKED_IN: "clocked-in",
  CLOCKED_OUT: "clocked-out",
}

function fmtTime(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "—"
}

export default async function AdminEmployeesPage() {
  const session = await requirePortalSession("ADMIN")
  const orgId = session.organizationId ?? null
  const employees = await adminAttendanceService.getEmployeeList(orgId)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {employees.length} people
        </p>
        <h2 className="mt-0.5 font-headline text-2xl font-bold text-foreground">
          Employees
        </h2>
      </div>

      <Card>
        <CardContent className="p-3">
          {employees.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No employees in this organisation yet.
            </p>
          ) : (
            <div className="space-y-1">
              {employees.map((e) => (
                <Link
                  key={e.id}
                  href={`/admin/attendance/employees/${e.id}`}
                  className="flex items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition hover:border-border/60 hover:bg-secondary/30"
                >
                  <Avatar className="h-9 w-9">
                    <AvatarFallback>{e.initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {e.name}
                      </p>
                      <Badge
                        variant={e.role === "SUPERVISOR" ? "overtime" : "outline"}
                        className="text-[9px]"
                      >
                        {e.role}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {e.jobTitle ?? "—"}
                      {e.project ? ` • ${e.project}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {e.todayStatus ? (
                      <div className="hidden text-right sm:block">
                        <Badge variant={STATUS_VARIANT[e.todayStatus] as never}>
                          {attendanceStatusMeta[e.todayStatus].label}
                        </Badge>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {fmtTime(e.todayTimeIn)}
                        </p>
                      </div>
                    ) : (
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">
                        no clock-in
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
