import "server-only"

import { getEmployeeStore } from "@/lib/app-store"
import { loadEmployeeData } from "@/lib/load-user-data"
import { getCurrentSession } from "@/lib/auth/session"
import {
  buildEmployeeDashboard,
} from "@/modules/claims/application/services/claim-analytics"
import type {
  ClaimRecord,
  EmployeeAccountData,
  EmployeeDashboardData,
} from "@/modules/claims/domain/models"

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
  return buildEmployeeDashboard(store.employee, store.claims)
}

export async function getEmployeeClaimHistory(): Promise<ClaimRecord[] | null> {
  const store = await getStore()
  if (!store) return null
  return store.claims
}

export async function getEmployeeAccount(): Promise<EmployeeAccountData | null> {
  const store = await getStore()
  if (!store) return null
  return {
    employee: store.employee,
    preferences: {
      notifications: true,
      weeklyDigest: true,
      expensePolicyVersion: "2026.1",
    },
  }
}
