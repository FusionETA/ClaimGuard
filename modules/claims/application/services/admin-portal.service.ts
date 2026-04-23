import "server-only"

import { getAdminStore, clearAdminStore } from "@/lib/app-store"
import { loadAdminData } from "@/lib/load-user-data"
import { getCurrentSession } from "@/lib/auth/session"
import { isStoreExpired } from "@/lib/app-store"
import {
  buildAdminOverview,
} from "@/modules/claims/application/services/claim-analytics"
import type {
  AdminDashboardData,
  ClaimRecord,
  OrganizationMember,
} from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

/**
 * Resolves the current admin's store entry.
 * Returns null if there is no valid session or the admin cannot be found.
 * Pages are responsible for calling redirect() when null is returned.
 */
async function getStore() {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return null
  }

  let store = getAdminStore()

  // Evict if the cached entry has passed its TTL.
  if (store && isStoreExpired(store.cachedAt)) {
    clearAdminStore()
    store = null
  }

  if (!store) {
    // Server restart cleared memory — reload from DB transparently.
    try {
      await loadAdminData(session.email)
    } catch {
      return null
    }
    store = getAdminStore()
  }

  return store ?? null
}

export async function getAdminDashboard(): Promise<AdminDashboardData | null> {
  const store = await getStore()
  if (!store) return null

  return {
    admin: store.admin,
    ...buildAdminOverview(store.allClaims),
  }
}

export async function getAdminClaimsQueue(): Promise<ClaimRecord[] | null> {
  const store = await getStore()
  if (!store) return null
  return store.allClaims
}

export async function getOrganizationHierarchy(): Promise<OrganizationMember[] | null> {
  const store = await getStore()
  if (!store) return null
  return claimRepository.getOrganizationMembers()
}

/** Called after a claim is submitted so the admin queue stays fresh. */
export function invalidateAdminStore(): void {
  clearAdminStore()
}
