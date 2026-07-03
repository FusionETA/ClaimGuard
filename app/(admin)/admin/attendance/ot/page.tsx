import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

import { OtAdminTable } from "./ot-admin-table"

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function monthAgoIso() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export default async function AdminOtPage() {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)

  const from = monthAgoIso()
  const to = todayIso()

  const rows = orgId
    ? await adminAttendanceService.getOtSubmissionsForOrg({
        orgId,
        from: new Date(from),
        to: new Date(to),
      })
    : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Attendance
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-foreground">Overtime</h2>
      </div>

      <OtAdminTable initialRows={rows} initialFrom={from} initialTo={to} />
    </div>
  )
}
