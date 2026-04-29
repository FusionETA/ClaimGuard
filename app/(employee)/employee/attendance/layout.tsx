import { AttendanceSubNav } from "@/components/attendance/sub-nav"
import { requirePortalSession } from "@/lib/auth/session"

const baseItems = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/clock", label: "Clock" },
  { href: "/employee/attendance/history", label: "History" },
  { href: "/employee/attendance/ot", label: "OT" },
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
    <div className="attendance-module -mx-6 -my-6 px-6 py-6 lg:-my-8 lg:py-8">
      <AttendanceSubNav items={items} />
      {children}
    </div>
  )
}
