import { redirect } from "next/navigation"
import { isAdminRole } from "@/lib/auth/types"

import { LeaveSettingsView } from "@/components/admin/leave/leave-settings-view"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { ensureDefaultLeaveTypesForOrg } from "@/modules/leave/application/services/leave-defaults.service"
import { listLeaveTypes } from "@/modules/leave/application/services/leave-types.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

export default async function AdminLeaveSettingsPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")

  // Seed the org's built-in leave types if missing. No-op when they
  // already exist. Existing rows are never overwritten.
  await ensureDefaultLeaveTypesForOrg(orgId)

  const year = new Date().getUTCFullYear()
  const [leaveTypes, allPolicies, policyDefaultsRaw, employees, employeeEntitlements] =
    await Promise.all([
      listLeaveTypes(orgId, true),
      policyRepository.listForOrganization(orgId),
      leaveRepository.listPolicyDefaults(orgId),
      leaveRepository.listEmployeesForLeaveSettings(orgId),
      leaveRepository.listEmployeeEntitlementsForOrg(orgId, year),
    ])

  // Settings UI only needs id/name/isDefault — strip the rest and drop
  // archived policies (matches the previous `archivedAt: null` filter).
  const policies = allPolicies
    .filter((p) => !p.archived)
    .map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return (
    <LeaveSettingsView
      orgId={orgId}
      year={year}
      leaveTypes={leaveTypes.map((t) => ({
        ...t,
        // `listLeaveTypes` goes through `getOrSetCache`, which JSON-
        // round-trips `Date` to `string`. On a cache miss the value is
        // still a Date; on a cache hit it's already a string. Normalize
        // both into the ISO string the view component expects.
        archivedAt:
          t.archivedAt == null
            ? null
            : t.archivedAt instanceof Date
              ? t.archivedAt.toISOString()
              : String(t.archivedAt),
      }))}
      policies={policies}
      policyDefaults={policyDefaultsRaw}
      employees={employees}
      employeeEntitlements={employeeEntitlements}
    />
  )
}
