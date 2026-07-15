import "server-only"

import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Superadmin support-mode services. Used exclusively by the
 * `/admin/support` picker page — see there for the gate + calling
 * pattern. Callers are ALWAYS assumed to be superadmins (the page
 * guard is the source of truth); this service does not re-check.
 */

/**
 * Data for the org-picker page: every organisation on the platform
 * with a lightweight summary the picker UI can render. Sorted by
 * name.
 */
export async function getSupportPickerPageData(): Promise<{
  orgs: Array<{
    id: string
    name: string
    plan: string
    tier: string | null
    ownerEmail: string | null
    employeeCount: number
  }>
}> {
  const orgs = await organizationRepository.listAllForSuperadmin()
  return { orgs }
}

/**
 * Resolve a target org id to a display-safe summary, used by the
 * banner + confirmation UI so a superadmin can see which org they're
 * about to enter. Returns null when the id doesn't match any org.
 */
export async function getSupportTargetOrg(orgId: string): Promise<{
  id: string
  name: string
  ownerEmail: string | null
} | null> {
  const summary = await organizationRepository.getOrganizationById(orgId)
  if (!summary) return null
  const detail = await organizationRepository.listAllForSuperadmin()
  const owner = detail.find((r) => r.id === orgId)
  return {
    id: summary.id,
    name: summary.name,
    ownerEmail: owner?.ownerEmail ?? null,
  }
}
