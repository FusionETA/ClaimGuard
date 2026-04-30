import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { AdminSettingsPanel } from "@/components/admin/admin-settings-panel"
import { getCurrentSession } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { getXeroConnectionSummary } from "@/modules/organization/application/services/xero-connection.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import type { XeroTenant } from "@/lib/xero"

const XERO_PENDING_COOKIE = "claimguard_xero_pending"
const ACTIVE_CONNECTION_COOKIE = "claimguard_active_connection"

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  const params = (await searchParams) ?? {}
  const admin = await claimRepository.getAdminProfile(session.email)

  if (!admin) redirect("/login")

  // activeOrganizationId reflects the company selected in the org dropdown;
  // fall back to the admin's own org if not set.
  const organizationId = session.activeOrganizationId ?? admin.organizationId ?? session.organizationId

  // Resolve active connection: prefer session value, then cookie, then first connection
  const cookieStore = await cookies()
  const cookieConnectionId = cookieStore.get(ACTIVE_CONNECTION_COOKIE)?.value
  const sessionConnectionId = session.activeXeroConnectionId

  const [organization, xeroConnection] = await Promise.all([
    organizationId
      ? organizationRepository.getOrganizationById(organizationId)
      : Promise.resolve(null),
    getXeroConnectionSummary(organizationId),
  ])

  // Determine the active connection ID — prefer session > cookie > first available
  let activeXeroConnectionId =
    sessionConnectionId ??
    cookieConnectionId ??
    (xeroConnection.connections[0]?.id ?? undefined)

  // Validate it still belongs to this org
  if (
    activeXeroConnectionId &&
    !xeroConnection.connections.find((c) => c.id === activeXeroConnectionId)
  ) {
    activeXeroConnectionId = xeroConnection.connections[0]?.id ?? undefined
  }

  // Fetch COA, projects, members scoped to the active connection (if set)
  const [chartAccounts, projects, customAccounts, members, workingHours] = await Promise.all([
    activeXeroConnectionId
      ? organizationRepository.getChartAccountsForConnection(activeXeroConnectionId)
      : Promise.resolve([]),
    organizationId
      ? organizationRepository.getProjectsForOrganization(organizationId)
      : Promise.resolve([]),
    organizationId
      ? organizationRepository.getCustomChartAccountsForOrganization(organizationId)
      : Promise.resolve([]),
    organizationId
      ? organizationRepository.getOrganizationMembers(organizationId)
      : Promise.resolve([]),
    adminAttendanceService.getWorkingHours(organizationId ?? null),
  ])

  // When the OAuth callback returned multiple tenants, the token is stored in a
  // short-lived pending cookie and the user is sent here to pick one.
  let pendingTenants: XeroTenant[] | undefined
  let takenTenantIds: string[] = []
  if (params.xero === "select-tenant") {
    const raw = cookieStore.get(XERO_PENDING_COOKIE)?.value
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed.tenants)) {
          pendingTenants = parsed.tenants as XeroTenant[]

          if (organizationId && pendingTenants.length > 0) {
            takenTenantIds = await organizationRepository.getInUseTenantIds(
              pendingTenants.map((t) => t.tenantId),
              organizationId
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
      admin={admin}
      organization={organization ?? undefined}
      xeroConnection={xeroConnection}
      chartAccounts={chartAccounts}
      customAccounts={customAccounts}
      projects={projects}
      members={members}
      activeXeroConnectionId={activeXeroConnectionId}
      xeroStatus={typeof params.xero === "string" ? params.xero : undefined}
      xeroReason={typeof params.reason === "string" ? params.reason : undefined}
      pendingTenants={pendingTenants}
      takenTenantIds={takenTenantIds}
      workingHours={workingHours}
      initialTab={typeof params.tab === "string" ? params.tab : "organization"}
    />
  )
}
