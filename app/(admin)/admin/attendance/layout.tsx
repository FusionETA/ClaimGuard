import { AttendanceSubNav } from "@/components/attendance/sub-nav"

const items = [
  { href: "/admin/attendance", label: "Overview" },
  { href: "/admin/attendance/approvals", label: "Approvals" },
]

export default function AdminAttendanceLayout({
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
