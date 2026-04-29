import { AttendanceSubNav } from "@/components/attendance/sub-nav"
import { requirePortalSession } from "@/lib/auth/session"

const baseItems = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/history", label: "History" },
]

const supervisorItems = [
  { href: "/employee/attendance/team", label: "Team" },
  { href: "/employee/attendance/approvals", label: "Approvals" },
]

export default async function EmployeeAttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")
  const items =
    session.role === "SUPERVISOR" ? [...baseItems, ...supervisorItems] : baseItems

  return (
    <>
      <AttendanceSubNav items={items} />
      {children}
    </>
  )
}
