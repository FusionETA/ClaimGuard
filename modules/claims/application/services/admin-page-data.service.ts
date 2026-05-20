import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { key } from "@/lib/redis"
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
  TeamDetail,
  TeamSummary,
  XeroConnectionInfo,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"
import { getXeroConnectionSummary } from "@/modules/organization/application/services/xero-connection.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import type { EmployeePolicy } from "@/modules/policy/domain/models"

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
  policies: EmployeePolicy[]
}

export async function getAdminHierarchyPageData(input: {
  organizationId: string | undefined
}): Promise<AdminHierarchyPageData | null> {
  // No org context — fall straight through to the loader (no caching
  // for unauthed/unscoped reads).
  if (!input.organizationId) {
    return loadAdminHierarchyPageData(input)
  }
  // 1-hour TTL — hierarchy + projects + Xero connections change rarely.
  // `bustOrgConfigCaches` invalidates this on hierarchy / settings /
  // project mutations, so the next page load is always fresh. The TTL
  // is the backstop in case a bust ever fails.
  return getOrSetCache(
    key("org", input.organizationId, "config", "page", "hierarchy"),
    3600,
    () => loadAdminHierarchyPageData(input),
  )
}

async function loadAdminHierarchyPageData(input: {
  organizationId: string | undefined
}): Promise<AdminHierarchyPageData | null> {
  const members = await getOrganizationHierarchy()
  if (members === null) return null

  const [organization, projects, xeroConnections, teams, policies] = await Promise.all([
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
    input.organizationId
      ? policyRepository.listForOrganization(input.organizationId)
      : Promise.resolve<EmployeePolicy[]>([]),
  ])

  return {
    members,
    projects,
    xeroConnections,
    organizationName: organization?.name ?? "",
    teams,
    policies,
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
  timezone: string
  activeXeroConnectionId?: string
}

export async function getAdminSettingsPageData(input: {
  adminEmail: string
  organizationId: string | undefined
  preferredConnectionId: string | undefined
}): Promise<AdminSettingsPageData | null> {
  if (!input.organizationId) {
    return loadAdminSettingsPageData(input)
  }
  // Cache key has to encode both org AND admin email AND preferred Xero
  // connection — the same org viewed by two admins, or with different
  // active connections, can resolve to different settings (Xero
  // chart-of-accounts is connection-scoped). 1-hour TTL — settings
  // change infrequently and `bustOrgConfigCaches` sweeps the org
  // namespace on any settings/chart-account/project mutation.
  return getOrSetCache(
    key(
      "org",
      input.organizationId,
      "config",
      "page",
      "settings",
      input.adminEmail,
      input.preferredConnectionId ?? "_none",
    ),
    3600,
    () => loadAdminSettingsPageData(input),
  )
}

async function loadAdminSettingsPageData(input: {
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

  const [chartAccounts, projects, customAccounts, members, workingHours, timezone] =
    await Promise.all([
      // Org-level chart-of-accounts (not connection-scoped). One active
      // Xero connection per org + custom accounts disabled on connect
      // means this returns exactly the live connection's accounts — but
      // without depending on `activeXeroConnectionId` being set, which
      // removes the "null connection → empty Accounts tab" risk.
      input.organizationId
        ? organizationRepository.getChartAccountsForOrganization(input.organizationId)
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
      adminAttendanceService.getOrgTimezone(input.organizationId ?? null),
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
    timezone,
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
  /// Teams with their member rosters joined in (one query upstream). The
  /// inline "Members" UI in the team detail panel reads `team.members`
  /// directly — no per-team round-trip needed.
  teams: TeamDetail[]
  /// Org-wide member list. Used as the picker source for both the
  /// project-managers picker (left column) and the team-members picker
  /// (middle column). Filtering to project-only / not-already-in-team
  /// happens in the component.
  members: OrganizationMember[]
}

/**
 * Combined data for `/admin/company-structure`. Returns null when the admin
 * has no active organisation yet (the page should redirect to /login or show
 * an empty-state).
 *
 * `teams` carries members inline so the page can render rosters without
 * extra round-trips, and `members` is the org-wide pool used by both the
 * project-managers picker and the team-members picker.
 */
export async function getAdminCompanyStructurePageData(input: {
  organizationId: string | undefined
}): Promise<AdminCompanyStructurePageData | null> {
  if (!input.organizationId) return null

  // 1-hour TTL — projects/teams/members change rarely once an org is
  // set up, and `bustOrgConfigCaches` invalidates on every team /
  // member / project mutation.
  return getOrSetCache(
    key("org", input.organizationId, "config", "page", "company-structure"),
    3600,
    () => loadAdminCompanyStructurePageData(input.organizationId!),
  )
}

async function loadAdminCompanyStructurePageData(
  organizationId: string,
): Promise<AdminCompanyStructurePageData | null> {
  const [organization, projects, teams, members] = await Promise.all([
    organizationRepository.getOrganizationById(organizationId),
    organizationRepository.getProjectsForOrganization(organizationId),
    organizationRepository.listTeamsWithMembers(organizationId),
    organizationRepository.getOrganizationMembers(organizationId),
  ])

  return {
    organizationName: organization?.name ?? "",
    projects,
    teams,
    members,
  }
}
