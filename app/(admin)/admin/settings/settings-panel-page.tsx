import { cookies } from "next/headers"
import { isAdminRole, isOwnerRole } from "@/lib/auth/types"
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
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
import { apiIntegrationRepository } from "@/modules/organization/infrastructure/api-integration.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import { listXeroTrackingCategoriesForConnection } from "@/modules/organization/application/services/xero-connection.service"
import type { XeroTrackingCategoryOption } from "@/components/admin/xero-tracking-category-picker"

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
  if (!session || !isAdminRole(session.role)) redirect("/login")

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

  // Filter the Policies tab to only policies the admin was granted
  // access to. Owners / legacy admins (null scope) see them all.
  const policyIdScope = await getActiveAdminPolicyScope()
  const allPolicies = orgIdForAdmins
    ? await policyRepository.listForOrganization(orgIdForAdmins)
    : []
  const policies =
    policyIdScope === null
      ? allPolicies
      : allPolicies.filter((p) => policyIdScope.includes(p.id))

  // Live read of the org's Xero Tracking Categories for the picker on the
  // Projects tab. Skipped when there's no active connection. We also pull
  // the currently-picked category id + name from the connection record so
  // the dropdown can seed its initial value and show "currently syncing
  // from X". Fetch errors surface as `xeroTrackingCategoriesError` and
  // the picker renders an inline error in place of the dropdown.
  let xeroTrackingCategories: XeroTrackingCategoryOption[] | undefined
  let xeroTrackingCategoriesError: string | undefined
  let pickedTrackingCategoryId: string | null = null
  let pickedTrackingCategoryName: string | null = null
  if (data.activeXeroConnectionId) {
    const connection = await organizationRepository.getXeroConnectionById(
      data.activeXeroConnectionId,
    )
    pickedTrackingCategoryId = connection?.xeroTrackingCategoryId ?? null
    pickedTrackingCategoryName = connection?.xeroTrackingCategoryName ?? null

    const live = await listXeroTrackingCategoriesForConnection(
      data.activeXeroConnectionId,
    )
    if (live.ok && live.categories) {
      xeroTrackingCategories = live.categories.map((c) => ({
        xeroTrackingCategoryId: c.xeroTrackingCategoryId,
        name: c.name,
        optionCount: c.options.length,
      }))
    } else {
      xeroTrackingCategoriesError = live.message
    }
  }

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
      canManageAdmins={isOwnerRole(session.role)}
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
      xeroTrackingCategories={xeroTrackingCategories}
      xeroTrackingCategoriesError={xeroTrackingCategoriesError}
      pickedTrackingCategoryId={pickedTrackingCategoryId}
      pickedTrackingCategoryName={pickedTrackingCategoryName}
    />
  )
}
