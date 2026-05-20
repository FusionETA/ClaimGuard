import { LeaveApprovalsList } from "@/components/leave/leave-approvals-list"
import { requirePortalSession } from "@/lib/auth/session"
import { listPendingApprovalsForReviewer } from "@/modules/leave/application/services/leave-application.service"

export default async function EmployeeLeaveApprovalsPage() {
  const session = await requirePortalSession("EMPLOYEE")
  const items = await listPendingApprovalsForReviewer(session.userId)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Approvals
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-foreground">Leave approvals queue</h2>
        <p className="text-sm text-muted-foreground">
          Pending leave applications waiting for your decision.
        </p>
      </div>

      <LeaveApprovalsList
        items={items.map((a) => ({
          id: a.id,
          employeeName: a.employeeName,
          leaveTypeCode: a.leaveTypeCode,
          leaveTypeName: a.leaveTypeName,
          paid: a.paid,
          startDate: a.startDate.toISOString(),
          endDate: a.endDate.toISOString(),
          duration: a.duration,
          totalDays: a.totalDays,
          reason: a.reason,
          attachmentUrl: a.attachmentUrl,
          attachmentName: a.attachmentName,
          currentStep: a.currentStep,
          createdAt: a.createdAt.toISOString(),
        }))}
      />
    </div>
  )
}
