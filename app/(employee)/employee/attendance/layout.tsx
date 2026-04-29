import { AttendanceSubNav } from "@/components/attendance/sub-nav"

const items = [
  { href: "/employee/attendance", label: "Dashboard" },
  { href: "/employee/attendance/clock", label: "Clock" },
  { href: "/employee/attendance/history", label: "History" },
  { href: "/employee/attendance/ot", label: "OT" },
]

export default function EmployeeAttendanceLayout({
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
