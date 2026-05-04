import "server-only"

import { getAdminStore, clearAdminStore } from "@/lib/app-store"
import { loadAdminData } from "@/lib/load-user-data"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isStoreExpired } from "@/lib/app-store"
import {
  buildAdminOverview,
} from "@/modules/claims/application/services/claim-analytics"
import type {
  AdminDashboardData,
  ClaimRecord,
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

  let store = getAdminStore(session.email)

  // Evict if the cached entry has passed its TTL or the active connection changed.
  if (
    store &&
    (isStoreExpired(store.cachedAt) ||
      store.activeOrganizationId !==
        (resolveActiveOrgId(session)) ||
      store.activeXeroConnectionId !== session.activeXeroConnectionId)
  ) {
    clearAdminStore(session.email)
    store = null
  }

  if (!store) {
    // Server restart cleared memory or connection switched — reload from DB transparently.
    try {
      await loadAdminData(
        session.email,
        resolveActiveOrgId(session),
        session.activeXeroConnectionId
      )
    } catch {
      return null
    }
    store = getAdminStore(session.email)
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

/** Called after a claim is submitted so the admin queue stays fresh. */
export function invalidateAdminStore(email?: string): void {
  clearAdminStore(email)
}
