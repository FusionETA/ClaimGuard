import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("ADMIN")
  const activeOrganizationId = resolveActiveOrgId(session)

  // Resolve this admin's module-access scope for the active org so the
  // shell can hide sidebar links the owner hasn't granted. Owners and
  // legacy admins (no AdminOrganization row) come back as `null` = full
  // access. The repo gates by role internally — no extra checks here.
  const accessModules = activeOrganizationId
    ? await organizationRepository.getAdminModulesForOrg({
        adminId: session.userId,
        organizationId: activeOrganizationId,
        userRole: session.role,
      })
    : null

  return (
    <AdminShell
      user={session}
      organizationName={session.organizationName}
      activeOrganizationId={activeOrganizationId}
      accessModules={accessModules}
    >
      {children}
    </AdminShell>
  )
}
