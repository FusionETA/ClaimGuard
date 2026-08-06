import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getActiveAdminAccessModules } from "@/modules/organization/application/services/admin-access.service"
import { getSupportTargetOrg } from "@/modules/organization/application/services/superadmin-support.service"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("ADMIN")
  const activeOrganizationId = resolveActiveOrgId(session)

  // Effective module set the shell filters its nav by — the per-admin grant
  // capped to the org's plan-enabled modules (owner / legacy → null = full
  // access). Extracted to `getActiveAdminAccessModules` so the dashboard
  // Quick actions gate on the exact same set.
  const accessModules = await getActiveAdminAccessModules()

  // Support-mode context — only populated when this session belongs
  // to a superadmin AND is currently acting inside a DIFFERENT org
  // than their own home. The shell renders the yellow "you're in
  // support mode" banner + Exit button when this is present. When
  // the superadmin is inside their own home org, no banner shows
  // (they're just using the app normally).
  const inSupportMode =
    session.isSuperadmin === true &&
    activeOrganizationId != null &&
    activeOrganizationId !== session.organizationId
  const supportModeTarget = inSupportMode
    ? await getSupportTargetOrg(activeOrganizationId!)
    : null

  return (
    <AdminShell
      user={session}
      organizationName={session.organizationName}
      activeOrganizationId={activeOrganizationId}
      accessModules={accessModules}
      supportModeTarget={supportModeTarget}
    >
      {children}
    </AdminShell>
  )
}
