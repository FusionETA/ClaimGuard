import { redirect } from "next/navigation"

import { LeaveOverviewView } from "@/components/admin/leave/leave-overview-view"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { ensureDefaultLeaveTypesForOrg } from "@/modules/leave/application/services/leave-defaults.service"
import {
  getLeaveOverviewForOrg,
  listLeaveAuditLog,
} from "@/modules/leave/application/services/leave-overview.service"

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
  if (!session || session.role !== "ADMIN") redirect("/login")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")

  await ensureDefaultLeaveTypesForOrg(orgId)

  const auditFrom = startOfMonthIso()
  const auditTo = todayIso()

  const prisma = getPrismaClient()
  const [report, auditRows, leaveTypes] = await Promise.all([
    getLeaveOverviewForOrg(orgId),
    listLeaveAuditLog(orgId, { from: auditFrom, to: auditTo, limit: 50 }),
    prisma
      ? prisma.leaveType.findMany({
          where: { organizationId: orgId, archivedAt: null },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        })
      : Promise.resolve([]),
  ])

  return (
    <LeaveOverviewView
      report={report}
      auditRows={auditRows}
      leaveTypes={leaveTypes}
      auditFrom={auditFrom}
      auditTo={auditTo}
    />
  )
}
