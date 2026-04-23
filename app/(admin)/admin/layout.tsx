import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession } from "@/lib/auth/session"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("ADMIN")

  return <AdminShell user={session}>{children}</AdminShell>
}
