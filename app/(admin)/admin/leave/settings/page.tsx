import { redirect } from "next/navigation"

import { LeaveSettingsView } from "@/components/admin/leave/leave-settings-view"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { ensureDefaultLeaveTypesForOrg } from "@/modules/leave/application/services/leave-defaults.service"
import { listLeaveTypes } from "@/modules/leave/application/services/leave-types.service"

export default async function AdminLeaveSettingsPage() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")

  const prisma = getPrismaClient()
  if (!prisma) redirect("/admin")

  // Seed the org's built-in leave types if missing. No-op when they
  // already exist. Existing rows are never overwritten.
  await ensureDefaultLeaveTypesForOrg(orgId)

  const [leaveTypes, policies, policyDefaultsRaw, employees] = await Promise.all([
    listLeaveTypes(orgId, true),
    prisma.employeePolicy.findMany({
      where: { organizationId: orgId, archivedAt: null },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isDefault: true },
    }),
    prisma.policyLeaveEntitlement.findMany({
      where: { policy: { organizationId: orgId } },
      select: { policyId: true, leaveTypeId: true, defaultDays: true },
    }),
    prisma.employeeProfile.findMany({
      where: { user: { organizationId: orgId } },
      orderBy: { user: { name: "asc" } },
      select: {
        id: true,
        policyId: true,
        user: { select: { name: true, email: true } },
      },
    }),
  ])

  // Per-employee entitlements for the current year.
  const year = new Date().getUTCFullYear()
  const employeeEntitlements = await prisma.leaveEntitlement.findMany({
    where: {
      year,
      employee: { user: { organizationId: orgId } },
    },
    select: {
      employeeId: true,
      leaveTypeId: true,
      entitledDays: true,
    },
  })

  return (
    <LeaveSettingsView
      orgId={orgId}
      year={year}
      leaveTypes={leaveTypes.map((t) => ({
        ...t,
        archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
      }))}
      policies={policies}
      policyDefaults={policyDefaultsRaw}
      employees={employees.map((e) => ({
        id: e.id,
        policyId: e.policyId,
        name: e.user.name,
        email: e.user.email,
      }))}
      employeeEntitlements={employeeEntitlements}
    />
  )
}
