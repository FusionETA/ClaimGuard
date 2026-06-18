import "server-only"
import { isAdminRole } from "@/lib/auth/types"

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
import {
  getActiveAdminClaimPaymentTypeScope,
  getActiveAdminPolicyScope,
} from "@/modules/organization/application/services/admin-access.service"

function paymentTypeTag(
  paymentTypes: Array<"PERSONAL" | "COMPANY"> | undefined,
): string {
  if (!paymentTypes) return "_all"
  if (paymentTypes.length === 0) return "_none"
  return `t:${[...paymentTypes].sort().join(",")}`
}

/**
 * Admin-portal reads. Like the employee-portal service, the previous
 * in-memory `app-store` layer was removed. Cache lives in Redis
 * (when configured) or is bypassed entirely (graceful fallback).
 */

async function requireAdminSession() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  return session
}

export async function getAdminDashboard(): Promise<AdminDashboardData | null> {
  const session = await requireAdminSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // Restrict the dashboard tiles (total claims, needs review, approved
  // value) to the admin's policy scope AND `claims_personal` /
  // `claims_company` module grants. Cache key includes both so two
  // admins with different grants don't share entries.
  const [policyIdScope, paymentTypes] = await Promise.all([
    getActiveAdminPolicyScope(),
    getActiveAdminClaimPaymentTypeScope(),
  ])
  const scopeTag =
    policyIdScope === null
      ? "_all"
      : `p:${[...policyIdScope].sort().join(",")}`

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
      scopeTag,
      paymentTypeTag(paymentTypes),
    ),
    60,
    async () => {
      const [admin, allClaims] = await Promise.all([
        claimRepository.getAdminProfile(session.email),
        claimRepository.getClaimsForOrganization(orgId, {
          policyIdScope,
          paymentTypes,
        }),
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

  // Resolve the admin's per-org policy scope so restricted admins only
  // see claims submitted by employees on their granted policies, AND
  // their claim-type grants (claims_personal / claims_company) so the
  // queue hides claim payment types they aren't allowed to act on.
  // `null` = full access (owners + legacy admins).
  const [policyIdScope, paymentTypes] = await Promise.all([
    getActiveAdminPolicyScope(),
    getActiveAdminClaimPaymentTypeScope(),
  ])
  // Cache key includes deterministic tags so two admins with different
  // policy / claim-type grants don't share a cache entry. We sort + join
  // so {a,b} and {b,a} land on the same key.
  const scopeTag =
    policyIdScope === null
      ? "_all"
      : `p:${[...policyIdScope].sort().join(",")}`

  return getOrSetCache(
    key(
      "org",
      orgId,
      "claims",
      "queue",
      session.activeXeroConnectionId ?? "_all",
      scopeTag,
      paymentTypeTag(paymentTypes),
    ),
    60,
    () =>
      claimRepository.getClaimsForOrganization(orgId, {
        policyIdScope,
        paymentTypes,
      }),
  )
}
