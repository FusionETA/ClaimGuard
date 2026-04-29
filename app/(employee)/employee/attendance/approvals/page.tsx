import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

import { ApprovalsList } from "./approvals-list"

export default async function ApprovalsPage() {
  const session = await requirePortalSession("SUPERVISOR")
  const pending =
    await supervisorAttendanceService.getPendingApprovalsForSupervisor(session.userId)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Approvals
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-foreground">Approvals queue</h2>
      </div>

      <ApprovalsList items={pending} />
    </div>
  )
}
