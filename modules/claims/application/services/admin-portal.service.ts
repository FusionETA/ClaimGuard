import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { key } from "@/lib/redis"
import {
  buildAdminOverview,
} from "@/modules/claims/application/services/claim-analytics"
import type {
  AdminDashboardData,
  ClaimRecord,
} from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

/**
 * Admin-portal reads. Like the employee-portal service, the previous
 * in-memory `app-store` layer was removed. Cache lives in Redis
 * (when configured) or is bypassed entirely (graceful fallback).
 */

async function requireAdminSession() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  return session
}

export async function getAdminDashboard(): Promise<AdminDashboardData | null> {
  const session = await requireAdminSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  return getOrSetCache(
    // Active xero-connection is part of the cache key because the
    // claims set narrows on it — switching connections must surface a
    // different result without waiting for TTL.
    key(
      "org",
      orgId,
      "claims",
      "admin-dashboard",
      session.activeXeroConnectionId ?? "_all",
    ),
    60,
    async () => {
      const [admin, allClaims] = await Promise.all([
        claimRepository.getAdminProfile(session.email),
        claimRepository.getClaimsForOrganization(orgId),
      ])
      if (!admin) return null
      return {
        admin,
        ...buildAdminOverview(allClaims),
      }
    },
  )
}

export async function getAdminClaimsQueue(): Promise<ClaimRecord[] | null> {
  const session = await requireAdminSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  return getOrSetCache(
    key(
      "org",
      orgId,
      "claims",
      "queue",
      session.activeXeroConnectionId ?? "_all",
    ),
    60,
    () => claimRepository.getClaimsForOrganization(orgId),
  )
}
