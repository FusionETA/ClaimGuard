import type { Route } from "next"

import { AttendanceSubNav } from "@/components/attendance/sub-nav"
import { requirePortalSession } from "@/lib/auth/session"
import { supervisorAttendanceService } from "@/modules/attendance/application/services/supervisor-attendance.service"

type AttendanceNavItem = {
  href: Route
  label: string
  badge?: boolean
}

const baseItems: ReadonlyArray<AttendanceNavItem> = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/history", label: "History" },
]

function getSupervisorItems(pendingApprovals: number): ReadonlyArray<AttendanceNavItem> {
  return [
    { href: "/employee/attendance/team", label: "Team" },
    {
      href: "/employee/attendance/approvals",
      label: "Approvals",
      badge: pendingApprovals > 0,
    },
  ]
}

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

  const items: ReadonlyArray<AttendanceNavItem> = isSupervisor
    ? [...baseItems, ...getSupervisorItems(pendingApprovals)]
    : baseItems

  return (
    <div className="attendance-module -mx-6 -my-6 px-6 py-6 lg:-my-8 lg:py-8">
      <AttendanceSubNav items={items} />
      {children}
    </div>
  )
}
