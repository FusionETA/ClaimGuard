import { redirect } from "next/navigation"

import { LeaveOverviewView } from "@/components/admin/leave/leave-overview-view"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { ensureDefaultLeaveTypesForOrg } from "@/modules/leave/application/services/leave-defaults.service"
import { getLeaveOverviewForOrg } from "@/modules/leave/application/services/leave-overview.service"

export default async function AdminLeavePage() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")

  await ensureDefaultLeaveTypesForOrg(orgId)
  const report = await getLeaveOverviewForOrg(orgId)

  return <LeaveOverviewView report={report} />
}
