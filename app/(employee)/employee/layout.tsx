import { EmployeeShell } from "@/components/layout/employee-shell"
import { requirePortalSession } from "@/lib/auth/session"

export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("EMPLOYEE")

  return <EmployeeShell user={session}>{children}</EmployeeShell>
}
