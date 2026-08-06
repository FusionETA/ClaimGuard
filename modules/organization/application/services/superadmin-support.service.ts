import "server-only"

import { getCurrentSession } from "@/lib/auth/session"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
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
    addons: string[]
    ownerEmail: string | null
    employeeCount: number
  }>
}> {
  const orgs = await organizationRepository.listAllForSuperadmin()
  return { orgs }
}

/**
 * Superadmin-only: change a company's subscription package + addon modules
 * (Claims / Attendance). Persists to the Organization row and writes an audit
 * entry — `writeAudit` routes it to the org's own log (as "System (Support)")
 * AND the Fusioneta-side SuperadminAuditLog with the real actor. The page
 * guard is the source of truth for the superadmin gate; this doesn't re-check.
 */
export async function updateOrgPlanForSupport(input: {
  organizationId: string
  plan: "DIY" | "EXPERT"
  tier: "FREE" | "PAID" | null
  addons: string[]
}): Promise<void> {
  await organizationRepository.updateOrgPlan(input)

  const session = await getCurrentSession()
  if (session) {
    void writeAudit({
      organizationId: input.organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "org.plan.update",
      status: "SUCCESS",
      summary: `Set package to ${input.plan}${
        input.tier ? ` · ${input.tier}` : ""
      } · add-ons: ${input.addons.length ? input.addons.join(", ") : "none"}`,
      targetType: "organization",
      targetId: input.organizationId,
    })
  }
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
