import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import {
  AdminSettingsPanel,
  type SettingsTabKey,
} from "@/components/admin/admin-settings-panel"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import type { XeroTenant } from "@/lib/xero"
import {
  getAdminSettingsPageData,
  getInUseTenantIds,
} from "@/modules/claims/application/services/admin-page-data.service"
import { apiIntegrationRepository } from "@/modules/organization/infrastructure/api-integration.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

const XERO_PENDING_COOKIE = "claimguard_xero_pending"
const ACTIVE_CONNECTION_COOKIE = "claimguard_active_connection"

type SettingsSearchParams = Record<string, string | string[] | undefined>

export async function AdminSettingsPanelPage({
  searchParams = {},
  initialTab,
  initialSection,
  visibleTabs,
}: {
  searchParams?: SettingsSearchParams
  initialTab?: string
  initialSection?: string
  visibleTabs?: SettingsTabKey[]
}) {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  const cookieStore = await cookies()
  const cookieConnectionId = cookieStore.get(ACTIVE_CONNECTION_COOKIE)?.value

  const data = await getAdminSettingsPageData({
    adminEmail: session.email,
    organizationId: resolveActiveOrgId(session),
    preferredConnectionId:
      session.activeXeroConnectionId ?? cookieConnectionId ?? undefined,
  })
  if (!data) redirect("/login")

  // Pull the admin list separately so the Organization tab can render
  // a "Manage admins" card. Empty array is fine when no org is selected.
  const orgIdForAdmins = resolveActiveOrgId(session)
  const admins = orgIdForAdmins
    ? await organizationRepository.listAdminsForOrganization(orgIdForAdmins)
    : []

  // External API tokens for the API tab. Same pattern — empty when no org.
  const apiIntegrations = orgIdForAdmins
    ? await apiIntegrationRepository.listForOrganization(orgIdForAdmins)
    : []

  const policies = orgIdForAdmins
    ? await policyRepository.listForOrganization(orgIdForAdmins)
    : []

  // OAuth callback "select-tenant" handling — read the pending cookie and
  // resolve which tenants are already in use by other orgs. Cookie/URL
  // concerns stay in the page, the DB lookup is a thin service helper.
  let pendingTenants: XeroTenant[] | undefined
  let takenTenantIds: string[] = []
  if (searchParams.xero === "select-tenant") {
    const raw = cookieStore.get(XERO_PENDING_COOKIE)?.value
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed.tenants)) {
          pendingTenants = parsed.tenants as XeroTenant[]
          const orgId = resolveActiveOrgId(session)
          if (orgId && pendingTenants.length > 0) {
            takenTenantIds = await getInUseTenantIds(
              pendingTenants.map((t) => t.tenantId),
              orgId,
            )
          }
        }
      } catch {
        // Malformed cookie — ignore, the action will handle the error
      }
    }
  }

  return (
    <AdminSettingsPanel
      admin={data.admin}
      organization={data.organization}
      xeroConnection={data.xeroConnection}
      chartAccounts={data.chartAccounts}
      customAccounts={data.customAccounts}
      projects={data.projects}
      members={data.members}
      admins={admins}
      apiIntegrations={apiIntegrations}
      policies={policies}
      currentAdminEmail={session.email}
      activeXeroConnectionId={data.activeXeroConnectionId}
      xeroStatus={
        typeof searchParams.xero === "string" ? searchParams.xero : undefined
      }
      xeroReason={
        typeof searchParams.reason === "string" ? searchParams.reason : undefined
      }
      pendingTenants={pendingTenants}
      takenTenantIds={takenTenantIds}
      workingHours={data.workingHours}
      timezone={data.timezone}
      initialTab={
        initialTab ??
        (typeof searchParams.tab === "string" ? searchParams.tab : "organization")
      }
      initialSection={
        initialSection ??
        (typeof searchParams.section === "string"
          ? searchParams.section
          : undefined)
      }
      visibleTabs={visibleTabs}
    />
  )
}
