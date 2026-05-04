import "server-only"

import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import {
  getAdminClaimsQueue,
  getAdminDashboard,
} from "@/modules/claims/application/services/admin-portal.service"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { getOrganizationHierarchy } from "@/modules/organization/application/services/organization-admin.service"
import type {
  AdminDashboardData,
  AdminProfile,
  ClaimRecord,
} from "@/modules/claims/domain/models"
import type {
  ChartOfAccountOption,
  OrganizationMember,
  OrganizationProjectOption,
  OrganizationSummary,
  TeamSummary,
  XeroConnectionInfo,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"
import { getXeroConnectionSummary } from "@/modules/organization/application/services/xero-connection.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Page-data services. Each function returns the full bag of data that one
 * admin page needs, so the page itself only handles HTTP concerns (cookies,
 * search params, redirects). Pages used to call 4-6 repository methods inline
 * — that violated the layered-architecture rule and made testing hard.
 *
 * `activeXeroConnectionId` resolution lives here too, since the rule
 * "session > cookie > first connection, validate it still belongs to the org"
 * was open-coded across `claims/page.tsx` and `settings/page.tsx`.
 */

/** Resolve the active Xero connection — session > cookie > first available. */
function resolveActiveConnection(
  xeroConnection: XeroConnectionSummary,
  preferredConnectionId: string | undefined,
): string | undefined {
  let activeId =
    preferredConnectionId ?? xeroConnection.connections[0]?.id ?? undefined
  if (
    activeId &&
    !xeroConnection.connections.find((c) => c.id === activeId)
  ) {
    activeId = xeroConnection.connections[0]?.id ?? undefined
  }
  return activeId
}

export type AdminClaimsPageData = {
  session: { email: string; role: string }
  claims: ClaimRecord[]
  dashboard: AdminDashboardData
  chartAccounts: ChartOfAccountOption[]
  activeXeroConnectionId?: string
}

/**
 * Combined data for `/admin/claims`. Returns null when the session is
 * unauthorised or the admin store can't be loaded — the page should
 * `redirect("/login")` in that case.
 *
 * `chartAccounts` is the org's selectable Chart of Account list, used by
 * the admin's "Final approve" dialog to optionally recode a claim against a
 * different account before approving.
 */
export async function getAdminClaimsPageData(input: {
  organizationId: string | undefined
  preferredConnectionId: string | undefined
}): Promise<{
  claims: ClaimRecord[]
  dashboard: AdminDashboardData
  chartAccounts: ChartOfAccountOption[]
  xeroConnection: XeroConnectionSummary
  activeXeroConnectionId?: string
} | null> {
  const [claims, dashboard, xeroConnection] = await Promise.all([
    getAdminClaimsQueue(),
    getAdminDashboard(),
    getXeroConnectionSummary(input.organizationId),
  ])
  if (!claims || !dashboard) return null

  const activeXeroConnectionId = resolveActiveConnection(
    xeroConnection,
    input.preferredConnectionId,
  )

  const chartAccounts = input.organizationId
    ? await organizationRepository.getSelectableChartAccountsForOrganization(
        input.organizationId,
      )
    : []

  return {
    claims,
    dashboard,
    chartAccounts,
    xeroConnection,
    activeXeroConnectionId,
  }
}

export type AdminHierarchyPageData = {
  members: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnections: XeroConnectionInfo[]
  organizationName: string
  teams: TeamSummary[]
}

export async function getAdminHierarchyPageData(input: {
  organizationId: string | undefined
}): Promise<AdminHierarchyPageData | null> {
  const members = await getOrganizationHierarchy()
  if (members === null) return null

  const [organization, projects, xeroConnections, teams] = await Promise.all([
    input.organizationId
      ? organizationRepository.getOrganizationById(input.organizationId)
      : Promise.resolve(null),
    input.organizationId
      ? organizationRepository.getProjectsForOrganization(input.organizationId)
      : Promise.resolve([]),
    input.organizationId
      ? organizationRepository.getXeroConnections(input.organizationId)
      : Promise.resolve([]),
    input.organizationId
      ? organizationRepository.listTeams(input.organizationId)
      : Promise.resolve<TeamSummary[]>([]),
  ])

  return {
    members,
    projects,
    xeroConnections,
    organizationName: organization?.name ?? "",
    teams,
  }
}

export type AdminSettingsPageData = {
  admin: AdminProfile
  organization: OrganizationSummary | undefined
  xeroConnection: XeroConnectionSummary
  chartAccounts: ChartOfAccountOption[]
  customAccounts: ChartOfAccountOption[]
  projects: OrganizationProjectOption[]
  members: OrganizationMember[]
  workingHours: { start: string; end: string }
  activeXeroConnectionId?: string
}

export async function getAdminSettingsPageData(input: {
  adminEmail: string
  organizationId: string | undefined
  preferredConnectionId: string | undefined
}): Promise<AdminSettingsPageData | null> {
  const admin = await claimRepository.getAdminProfile(input.adminEmail)
  if (!admin) return null

  const [organization, xeroConnection] = await Promise.all([
    input.organizationId
      ? organizationRepository.getOrganizationById(input.organizationId)
      : Promise.resolve(null),
    getXeroConnectionSummary(input.organizationId),
  ])

  const activeXeroConnectionId = resolveActiveConnection(
    xeroConnection,
    input.preferredConnectionId,
  )

  const [chartAccounts, projects, customAccounts, members, workingHours] =
    await Promise.all([
      activeXeroConnectionId
        ? organizationRepository.getChartAccountsForConnection(activeXeroConnectionId)
        : Promise.resolve([]),
      input.organizationId
        ? organizationRepository.getProjectsForOrganization(input.organizationId)
        : Promise.resolve([]),
      input.organizationId
        ? organizationRepository.getCustomChartAccountsForOrganization(input.organizationId)
        : Promise.resolve([]),
      input.organizationId
        ? organizationRepository.getOrganizationMembers(input.organizationId)
        : Promise.resolve([]),
      adminAttendanceService.getWorkingHours(input.organizationId ?? null),
    ])

  return {
    admin,
    organization: organization ?? undefined,
    xeroConnection,
    chartAccounts,
    customAccounts,
    projects,
    members,
    workingHours,
    activeXeroConnectionId,
  }
}

/**
 * Look up which Xero tenant ids in `pendingTenantIds` are already in use by
 * other organisations. Used by the settings page when handling the OAuth
 * callback's "select-tenant" state.
 */
export async function getInUseTenantIds(
  pendingTenantIds: string[],
  organizationId: string,
): Promise<string[]> {
  if (pendingTenantIds.length === 0) return []
  return organizationRepository.getInUseTenantIds(pendingTenantIds, organizationId)
}

export type AdminCompanyStructurePageData = {
  organizationName: string
  projects: OrganizationProjectOption[]
  teams: TeamSummary[]
}

/**
 * Combined data for `/admin/company-structure`. Returns null when the admin
 * has no active organisation yet (the page should redirect to /login or show
 * an empty-state).
 */
export async function getAdminCompanyStructurePageData(input: {
  organizationId: string | undefined
}): Promise<AdminCompanyStructurePageData | null> {
  if (!input.organizationId) return null

  const [organization, projects, teams] = await Promise.all([
    organizationRepository.getOrganizationById(input.organizationId),
    organizationRepository.getProjectsForOrganization(input.organizationId),
    organizationRepository.listTeams(input.organizationId),
  ])

  return {
    organizationName: organization?.name ?? "",
    projects,
    teams,
  }
}
