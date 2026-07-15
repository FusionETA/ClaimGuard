import { AdminShell } from "@/components/layout/admin-shell"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { deriveOrgEnabledModulesFromRow } from "@/modules/organization/domain/plan"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { getSupportTargetOrg } from "@/modules/organization/application/services/superadmin-support.service"

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
  const adminModules = activeOrganizationId
    ? await organizationRepository.getAdminModulesForOrg({
        adminId: session.userId,
        organizationId: activeOrganizationId,
        userRole: session.role,
      })
    : null

  // Intersect with the org's plan-enabled modules. A DIY-Free org
  // can't show Claims to anyone — not even the owner — so the per-
  // admin grant gets capped to what the org actually pays for.
  // Legacy orgs (no plan recorded) return null here → no intersection,
  // existing tenants keep their full nav until they're re-provisioned.
  const orgPlanRow = activeOrganizationId
    ? await organizationRepository.getOrgPlanModules(activeOrganizationId)
    : null
  const orgEnabledModules = orgPlanRow
    ? deriveOrgEnabledModulesFromRow(orgPlanRow)
    : null

  // Compute the effective module set the shell uses for nav filtering:
  //   - If the org has no plan recorded → pass adminModules through.
  //   - If admin has full access (null) → narrow to org-enabled set.
  //   - Otherwise → intersect both.
  let accessModules: readonly string[] | null = adminModules
  if (orgEnabledModules) {
    if (adminModules === null) {
      accessModules = orgEnabledModules
    } else {
      const orgSet = new Set<string>(orgEnabledModules)
      accessModules = adminModules.filter((m) => orgSet.has(m))
    }
  }

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
