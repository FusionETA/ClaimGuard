import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("ADMIN")
  const activeOrganizationId =
    resolveActiveOrgId(session)

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
