import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession } from "@/lib/auth/session"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("ADMIN")
  const activeOrganizationId =
    session.activeOrganizationId ?? session.organizationId

  return (
    <AdminShell
      user={session}
      organizationName={session.organizationName}
      activeOrganizationId={activeOrganizationId}
    >
      {children}
    </AdminShell>
  )
}
