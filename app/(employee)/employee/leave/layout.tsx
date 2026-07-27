import type { Route } from "next"

import { LeaveSubNav } from "@/components/leave/leave-sub-nav"
import { requirePortalSession } from "@/lib/auth/session"

type LeaveNavItem = {
  href: Route
  label: string
}

const employeeItems: ReadonlyArray<LeaveNavItem> = [
  { href: "/employee/leave", label: "My Leave" },
]

/// Supervisor order — Approvals sits right after "My Leave" so the
/// action-heavy tab is one tap away, mirroring the attendance
/// supervisor ordering. Team Balances is the informational tail.
const supervisorItems: ReadonlyArray<LeaveNavItem> = [
  { href: "/employee/leave", label: "My Leave" },
  { href: "/employee/leave/approvals", label: "Approvals" },
  { href: "/employee/leave/team", label: "Team Balances" },
]

export default async function EmployeeLeaveLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const items =
    session.role === "SUPERVISOR" ? supervisorItems : employeeItems

  return (
    <>
      <LeaveSubNav role={session.role} items={items} />
      {children}
    </>
  )
}
