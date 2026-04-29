import { AttendanceSubNav } from "@/components/attendance/sub-nav"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

const baseItems = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/history", label: "History" },
] as const

export default async function EmployeeAttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const isSupervisor = session.role === "SUPERVISOR"
  const pendingApprovals = isSupervisor
    ? await supervisorAttendanceService.countPendingApprovalsForSupervisor(
        session.userId,
      )
    : 0

  const items = isSupervisor
    ? [
        ...baseItems,
        { href: "/employee/attendance/team", label: "Team" },
        {
          href: "/employee/attendance/approvals",
          label: "Approvals",
          badge: pendingApprovals > 0,
        },
      ]
    : [...baseItems]

  return (
    <>
      <AttendanceSubNav items={items} />
      {children}
    </>
  )
}
