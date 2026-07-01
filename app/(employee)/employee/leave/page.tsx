import { redirect } from "next/navigation"

import { EmployeeLeaveView } from "@/components/employee/leave/employee-leave-view"
import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { listEmployeeBalancesForUser } from "@/modules/leave/application/services/leave-entitlements.service"
import { listMyApplicationsForUser } from "@/modules/leave/application/services/leave-application.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { requireModuleAccess } from "@/modules/policy/application/guards"

export default async function EmployeeLeavePage() {
  const session = await requirePortalSession("EMPLOYEE")
  await requireModuleAccess("leave")

  const orgId = resolveActiveOrgId(session)

  // Confirm the user has an employee profile at the CURRENT active
  // org (multi-org users may have profiles at other companies — we
  // only want this one). Otherwise we have nothing to render for the
  // leave tab (e.g. an admin viewing the employee surface without an
  // underlying EmployeeProfile row).
  const profileId = await leaveRepository.findEmployeeProfileIdByUserId(
    session.userId,
    orgId,
  )
  if (!profileId) redirect("/")

  const year = new Date().getUTCFullYear()
  const [balances, applications, joinDate, organization] = await Promise.all([
    listEmployeeBalancesForUser(session.userId, year, orgId),
    listMyApplicationsForUser(session.userId, orgId),
    leaveRepository.getEmployeeJoinDate(profileId),
    orgId ? organizationRepository.getOrganizationById(orgId) : null,
  ])

  return (
    <EmployeeLeaveView
      year={year}
      joinDate={joinDate ? joinDate.toISOString() : null}
      allowForecastedLeaveApply={
        organization?.allowForecastedLeaveApply ?? false
      }
      balances={balances.map((b) => ({
        ...b,
        carriedExpiresAt: b.carriedExpiresAt ? b.carriedExpiresAt.toISOString() : null,
      }))}
      applications={applications.map((a) => ({
        id: a.id,
        leaveTypeId: a.leaveTypeId,
        leaveTypeCode: a.leaveTypeCode,
        leaveTypeName: a.leaveTypeName,
        paid: a.paid,
        startDate: a.startDate.toISOString(),
        endDate: a.endDate.toISOString(),
        duration: a.duration,
        totalDays: a.totalDays,
        reason: a.reason,
        attachmentUrl: a.attachmentUrl,
        attachmentName: a.attachmentName,
        status: a.status,
        currentStep: a.currentStep,
        approvalsCount: a.approvals.length,
        createdAt: a.createdAt.toISOString(),
        decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      }))}
    />
  )
}
