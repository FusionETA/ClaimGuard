import "server-only"

import { getCurrentSession } from "@/lib/auth/session"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { deriveOrgEnabledModules } from "@/modules/organization/domain/plan"
import { ensureDefaultLeaveTypesForOrg } from "@/modules/leave/application/services/leave-defaults.service"

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
 * Superadmin-only: provision a brand-new company (Organization) with a
 * fresh OWNER account that logs in via the portal (password set here),
 * on the chosen plan. Seeds default leave types and grants the owner the
 * plan's modules. If the owner email already belongs to a user, that
 * account is linked as owner of the new company instead of creating a
 * duplicate (and its existing password is left untouched).
 *
 * Re-checks `isSuperadmin` itself (not only the page guard) since this
 * creates real accounts. Audits the provisioning.
 */
export async function createOwnerWithOrganization(input: {
  orgName: string
  ownerName: string
  ownerEmail: string
  password: string
  plan: "DIY" | "EXPERT"
  tier: "FREE" | "PAID" | null
  addons: string[]
}): Promise<{
  orgId: string
  orgName: string
  ownerEmail: string
  ownerCreated: boolean
}> {
  const session = await getCurrentSession()
  if (!session || !session.isSuperadmin) {
    throw new Error("Not authorized.")
  }

  const orgName = input.orgName.trim()
  if (orgName.length < 2) {
    throw new Error("Company name must be at least 2 characters.")
  }
  const ownerName = input.ownerName.trim()
  if (!ownerName) throw new Error("Owner name is required.")
  const ownerEmail = input.ownerEmail.trim().toLowerCase()
  if (!ownerEmail) throw new Error("Owner email is required.")
  if (input.password.length < 8) {
    throw new Error("Password must be at least 8 characters.")
  }

  const existingOrg = await organizationRepository.findOrganizationByName(orgName)
  if (existingOrg) {
    throw new Error(`A company named "${orgName}" already exists.`)
  }

  const planTriple = {
    plan: input.plan,
    // EXPERT has no tier split — store null.
    tier: input.plan === "EXPERT" ? null : input.tier,
    addons: input.addons,
  }

  const org = await organizationRepository.createOrganization({
    organizationName: orgName,
    plan: planTriple,
  })

  await ensureDefaultLeaveTypesForOrg(org.id)

  const owner = await organizationRepository.createOwnerForOrganization({
    organizationId: org.id,
    email: ownerEmail,
    name: ownerName,
    modules: deriveOrgEnabledModules(planTriple),
    password: input.password,
  })

  void writeAudit({
    organizationId: org.id,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "org.provision",
    status: "SUCCESS",
    summary: `Provisioned company "${orgName}" with owner ${ownerName} (${ownerEmail})${
      owner.created ? "" : " — linked an existing account"
    }.`,
    targetType: "organization",
    targetId: org.id,
  })

  return {
    orgId: org.id,
    orgName: org.name,
    ownerEmail,
    ownerCreated: owner.created,
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
