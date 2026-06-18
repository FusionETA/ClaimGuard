import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import {
  getActiveAdminClaimPaymentTypeScope,
  getActiveAdminPolicyScope,
} from "@/modules/organization/application/services/admin-access.service"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * Live counts behind the admin overview "Quick actions" card. Each
 * number is a "what needs me" cue for the matching shortcut:
 *   - pendingClaims        → Review claims (PENDING + SUBMITTED)
 *   - draftPayrollRuns     → Run payroll (DRAFT runs)
 *   - employeesNeedingSetup→ Manage employees (incomplete payroll profile)
 *   - pendingLeave         → Leave (applications awaiting a decision)
 *
 * Returns all zeros (rather than null) when there's no session/org so
 * the card still renders its shortcuts without badges.
 */
export type AdminQuickActionCounts = {
  pendingClaims: number
  draftPayrollRuns: number
  employeesNeedingSetup: number
  pendingLeave: number
}

export async function getAdminQuickActionCounts(): Promise<AdminQuickActionCounts> {
  const empty: AdminQuickActionCounts = {
    pendingClaims: 0,
    draftPayrollRuns: 0,
    employeesNeedingSetup: 0,
    pendingLeave: 0,
  }

  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return empty
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return empty

  const [policyIdScope, paymentTypes] = await Promise.all([
    getActiveAdminPolicyScope(),
    getActiveAdminClaimPaymentTypeScope(),
  ])
  const [pendingClaims, runs, employees, pendingLeave] = await Promise.all([
    claimRepository.countPendingForOrganization(orgId, {
      policyIdScope,
      paymentTypes,
    }),
    payrollRunRepository.listForOrganization(orgId),
    payrollProfileRepository.listForOrganization(orgId, { policyIdScope }),
    leaveRepository.countPendingForOrganization(orgId, { policyIdScope }),
  ])

  return {
    pendingClaims,
    draftPayrollRuns: runs.filter((r) => r.status === "DRAFT").length,
    employeesNeedingSetup: employees.filter(
      (e) => !e.isComplete && !e.isArchived,
    ).length,
    pendingLeave,
  }
}
