import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("ADMIN")
  const profile = await claimRepository.getAdminProfile(session.email)

  const xeroConnections = session.organizationId
    ? await organizationRepository.getXeroConnections(session.organizationId)
    : []

  return (
    <AdminShell
      user={session}
      organizationName={profile?.organizationName}
      xeroConnections={xeroConnections}
      activeXeroConnectionId={session.activeXeroConnectionId}
    >
      {children}
    </AdminShell>
  )
}
