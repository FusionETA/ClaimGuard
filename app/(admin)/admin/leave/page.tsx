import { redirect } from "next/navigation"
import { isAdminRole } from "@/lib/auth/types"

import { LeaveOverviewView } from "@/components/admin/leave/leave-overview-view"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { ensureDefaultLeaveTypesForOrg } from "@/modules/leave/application/services/leave-defaults.service"
import {
  getLeaveOverviewForOrg,
  listLeaveAuditLog,
} from "@/modules/leave/application/services/leave-overview.service"
import { listLeaveTypes } from "@/modules/leave/application/services/leave-types.service"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"
import { getOrganizationHierarchy } from "@/modules/organization/application/services/organization-admin.service"

function startOfMonthIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export default async function AdminLeavePage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  await requireAdminModule("leave")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")

  await ensureDefaultLeaveTypesForOrg(orgId)

  const auditFrom = startOfMonthIso()
  const auditTo = todayIso()

  const [report, auditRows, allLeaveTypes, hierarchy] = await Promise.all([
    getLeaveOverviewForOrg(orgId),
    listLeaveAuditLog(orgId, { from: auditFrom, to: auditTo, limit: 50 }),
    listLeaveTypes(orgId, false),
    // Same scope as the rest of the admin tools — restricted admins
    // only see employees on their granted policies via getActiveAdminPolicyScope.
    getOrganizationHierarchy(),
  ])

  // Trim down to what the view consumes — keeps the prop shape stable
  // and avoids dragging archivedAt / defaultDays through the wire.
  const leaveTypes = allLeaveTypes.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
  }))

  // Employee picker for the apply-on-behalf dialog. Drop anyone
  // without an EmployeeProfile (legacy / login-only users) — they
  // can't have leave applications anyway.
  const employeeOptions = (hierarchy ?? [])
    .filter((m) => Boolean(m.employeeProfileId))
    .map((m) => ({
      employeeProfileId: m.employeeProfileId as string,
      name: m.name,
      email: m.email,
      employeeId: m.employeeId,
    }))

  return (
    <LeaveOverviewView
      report={report}
      auditRows={auditRows}
      leaveTypes={leaveTypes}
      employees={employeeOptions}
      auditFrom={auditFrom}
      auditTo={auditTo}
    />
  )
}
