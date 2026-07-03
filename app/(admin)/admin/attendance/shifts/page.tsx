import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

import { ShiftsManager } from "@/components/admin/attendance/shifts-manager"

/**
 * Admin shift-management page — Phase 4 of the OT plan.
 *
 * A single flat table of every shift across every project, with a
 * project filter for scoping. Each row surfaces the shift's name,
 * time range, working days, lunch break, and assigned member count.
 * Actions: add / edit / delete / set as project default.
 *
 * We deliberately don't cache the shift list here — mutations
 * revalidate this path from the actions file, so a plain
 * `await service.listShifts` on each render is fine at typical
 * volumes (dozens per org).
 */
export default async function AdminShiftsPage() {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)

  if (!orgId) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card/94 p-6 text-sm text-muted-foreground">
        No active organisation. Pick one from the org switcher to manage
        shifts.
      </div>
    )
  }

  const [shifts, projects] = await Promise.all([
    adminAttendanceService.listShiftsForOrg(orgId),
    adminAttendanceService.listProjectsForOrg(orgId),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Shifts</h2>
        <p className="text-xs text-muted-foreground">
          One project can have multiple named shifts (e.g. Day 8am-5pm,
          Night 10pm-7am). Mark one as default per project — supervisors
          can override per team member. Late detection and expected daily
          hours read from the shift assigned to each employee.
        </p>
      </div>

      <ShiftsManager initialShifts={shifts} projects={projects} />
    </div>
  )
}
