import type { Route } from "next"

import { AttendanceSubNav } from "@/components/attendance/sub-nav"
import { requirePortalSession } from "@/lib/auth/session"

type AttendanceNavItem = {
  href: Route
  label: string
}

const baseItems: ReadonlyArray<AttendanceNavItem> = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/history", label: "History" },
  { href: "/employee/attendance/overtime", label: "Overtime" },
]

/// Supervisor sequence surfaces the action-heavy tabs first
/// (Approvals right after Dashboard so pending reviews are one tap
/// away). Non-supervisors keep the simpler baseItems order.
const supervisorItems: ReadonlyArray<AttendanceNavItem> = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/approvals", label: "Approvals" },
  { href: "/employee/attendance/overtime", label: "Overtime" },
  { href: "/employee/attendance/team", label: "Team" },
  { href: "/employee/attendance/history", label: "History" },
]

export default async function EmployeeAttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const items: ReadonlyArray<AttendanceNavItem> =
    session.role === "SUPERVISOR" ? supervisorItems : baseItems

  return (
    <div className="attendance-module -mx-6 -my-6 px-6 py-6 lg:-my-8 lg:py-8">
      <AttendanceSubNav items={items} />
      {children}
    </div>
  )
}
