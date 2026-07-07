import { OtRecordCard } from "@/components/attendance/ot-record-card"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { employeeAttendanceService } from "@/modules/attendance/application/services/employee-attendance.service"
import { requireModuleAccess } from "@/modules/policy/application/guards"
import { OtSubmitButton } from "../ot-submit-dialog"

export default async function OvertimePage() {
  const session = await requirePortalSession("EMPLOYEE")
  await requireModuleAccess("attendance")

  const orgId = resolveActiveOrgId(session)

  const [otRecords, projects, timezone] = await Promise.all([
    employeeAttendanceService.getEmployeeOTRecords(session.userId),
    employeeAttendanceService.getAvailableProjects(session.userId, orgId ?? undefined),
    attendanceRepository.getOrgTimezone(orgId ?? null),
  ])

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="font-headline text-xl font-bold text-foreground">Overtime</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Submit and track your overtime requests.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{otRecords.length} submissions</span>
      </div>

      {otRecords.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-surface-low p-8 text-center">
          <p className="text-sm font-medium text-foreground">No overtime submissions yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Tap the + button to submit an overtime request.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {otRecords.map((record) => (
            <OtRecordCard key={record.id} record={record} timezone={timezone ?? "UTC"} />
          ))}
        </div>
      )}

      <OtSubmitButton projects={projects} />
    </div>
  )
}
