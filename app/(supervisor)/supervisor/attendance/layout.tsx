import { AttendanceSubNav } from "@/components/attendance/sub-nav"

const items = [
  { href: "/supervisor/attendance", label: "Dashboard" },
  { href: "/supervisor/attendance/team", label: "Team" },
  { href: "/supervisor/attendance/approvals", label: "Approvals" },
]

export default function SupervisorAttendanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="attendance-module -mx-6 -my-6 px-6 py-6 lg:-my-8 lg:py-8">
      <AttendanceSubNav items={items} />
      {children}
    </div>
  )
}
