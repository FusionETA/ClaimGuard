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

  // Fetch all organizations this admin manages
  const adminOrganizations = session.userId
    ? await organizationRepository.getAdminOrganizations(session.userId)
    : []

  // Active org: prefer session selection, fall back to primary org
  const activeOrganizationId =
    session.activeOrganizationId ?? session.organizationId

  // Fetch Xero connections scoped to the currently active organization
  const xeroConnections = activeOrganizationId
    ? await organizationRepository.getXeroConnections(activeOrganizationId)
    : []

  return (
    <AdminShell
      user={session}
      organizationName={profile?.organizationName}
      adminOrganizations={adminOrganizations}
      activeOrganizationId={activeOrganizationId}
      xeroConnections={xeroConnections}
      activeXeroConnectionId={session.activeXeroConnectionId}
    >
      {children}
    </AdminShell>
  )
}
