import { redirect } from "next/navigation"

import { EmployeeLeaveView } from "@/components/employee/leave/employee-leave-view"
import { requirePortalSession } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { listEmployeeBalances } from "@/modules/leave/application/services/leave-entitlements.service"
import { listMyApplications } from "@/modules/leave/application/services/leave-application.service"
import { requireModuleAccess } from "@/modules/policy/application/guards"

export default async function EmployeeLeavePage() {
  const session = await requirePortalSession("EMPLOYEE")
  await requireModuleAccess("leave")

  const prisma = getPrismaClient()
  if (!prisma) redirect("/")
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId: session.userId },
    select: { id: true },
  })
  if (!profile) redirect("/")

  const year = new Date().getUTCFullYear()
  const [balances, applications] = await Promise.all([
    listEmployeeBalances(profile.id, year),
    listMyApplications(profile.id),
  ])

  return (
    <EmployeeLeaveView
      year={year}
      balances={balances.map((b) => ({
        ...b,
        carriedExpiresAt: b.carriedExpiresAt ? b.carriedExpiresAt.toISOString() : null,
      }))}
      applications={applications.map((a) => ({
        ...a,
        startDate: a.startDate.toISOString(),
        endDate: a.endDate.toISOString(),
        createdAt: a.createdAt.toISOString(),
        decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      }))}
    />
  )
}
