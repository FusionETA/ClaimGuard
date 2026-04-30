import "server-only"

import { getEmployeeStore, clearEmployeeStore } from "@/lib/app-store"
import { loadEmployeeData } from "@/lib/load-user-data"
import { getCurrentSession } from "@/lib/auth/session"
import { isStoreExpired } from "@/lib/app-store"
import {
  buildEmployeeDashboard,
} from "@/modules/claims/application/services/claim-analytics"
import { buildClaimRunPreview } from "@/modules/claims/application/services/claim-workflow.service"
import type {
  ClaimRecord,
  EmployeeAccountData,
  EmployeeClaimSubmissionData,
  EmployeeDashboardData,
} from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Resolves the current employee's store entry.
 * Returns null if there is no valid session or the employee cannot be found.
 * Pages are responsible for calling redirect() when null is returned.
 */
async function getStore() {
  const session = await getCurrentSession()

  if (!session || (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR")) {
    return null
  }

  let store = getEmployeeStore(session.email)

  // Evict if the cached entry has passed its TTL.
  if (store && isStoreExpired(store.cachedAt)) {
    clearEmployeeStore(session.email)
    store = null
  }

  if (!store) {
    // Server restart cleared memory — reload from DB transparently.
    try {
      await loadEmployeeData(session.email)
    } catch {
      return null
    }
    store = getEmployeeStore(session.email)
  }

  return store ?? null
}

export async function getEmployeeDashboard(): Promise<EmployeeDashboardData | null> {
  const store = await getStore()
  if (!store) return null
  const organization = store.employee.organizationId
    ? await organizationRepository.getOrganizationById(store.employee.organizationId)
    : null
  return buildEmployeeDashboard(store.employee, store.claims, organization ?? undefined)
}

export async function getEmployeeClaimHistory(): Promise<ClaimRecord[] | null> {
  const store = await getStore()
  if (!store) return null
  return store.claims
}

export async function getEmployeeAccount(): Promise<EmployeeAccountData | null> {
  const store = await getStore()
  if (!store) return null
  const organization = store.employee.organizationId
    ? await organizationRepository.getOrganizationById(store.employee.organizationId)
    : null
  return {
    employee: store.employee,
    organization: organization ?? undefined,
    preferences: {
      notifications: true,
      weeklyDigest: true,
      expensePolicyVersion: "2026.1",
    },
  }
}

export async function getEmployeeClaimSubmissionData(): Promise<EmployeeClaimSubmissionData | null> {
  const store = await getStore()
  if (!store) return null

  if (!store.employee.organizationId) {
    return {
      employee: store.employee,
      chartAccounts: [],
      bankAccounts: [],
    }
  }

  const [organization, chartAccounts, bankAccounts] = await Promise.all([
    organizationRepository.getOrganizationById(store.employee.organizationId),
    organizationRepository.getSelectableChartAccountsForEmployee({
      organizationId: store.employee.organizationId,
      xeroConnectionId: store.employee.xeroConnectionId,
    }),
    organizationRepository.getBankAccountsForOrganization({
      organizationId: store.employee.organizationId,
      xeroConnectionId: store.employee.xeroConnectionId,
    }),
  ])

  return {
    employee: store.employee,
    organization: organization ?? undefined,
    chartAccounts,
    bankAccounts,
    claimRunPreview: organization
      ? buildClaimRunPreview({
          submittedAt: new Date(),
          claimCutoffDay: organization.claimCutoffDay,
        })
      : undefined,
  }
}
