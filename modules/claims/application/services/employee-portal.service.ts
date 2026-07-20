import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { key } from "@/lib/redis"
import {
  buildEmployeeDashboard,
} from "@/modules/claims/application/services/claim-analytics"
import {
  buildClaimRunPreview,
  getPeriodWindow,
} from "@/modules/claims/application/services/claim-workflow.service"
import type {
  ChartAccountWithRemainingLimit,
  ClaimRecord,
  EmployeeAccountData,
  EmployeeClaimSubmissionData,
  EmployeeDashboardData,
  PortalUser,
} from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * All employee-portal reads go through Redis (when configured) or
 * straight to the repos (graceful fallback). The previous in-memory
 * `app-store` layer was removed because it introduced cross-worker
 * inconsistency and a stale-data feedback loop into Redis: when a
 * mutation busted Redis but didn't touch the per-process memory store,
 * the next read would refill Redis with stale data from memory. With
 * memory gone, Redis is the single source of truth for cached reads.
 */

/**
 * Resolve the current session and confirm it's an employee/supervisor.
 * Returns null when there's no session or the role is wrong — pages
 * call redirect() on null. Centralising the role check keeps each
 * service method short.
 */
async function requireEmployeeSession() {
  const session = await getCurrentSession()
  if (!session) return null
  if (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR") return null
  return session
}

export async function getEmployeeDashboard(): Promise<EmployeeDashboardData | null> {
  const session = await requireEmployeeSession()
  if (!session) return null

  // Multi-org: scope everything to the CURRENT active org so a
  // multi-org employee only sees the picked company's claims,
  // profile, and org config. Cache key uses the active org (not
  // legacy home org) so switching companies produces a distinct key.
  const orgId = resolveActiveOrgId(session)
  // No active org → skip cache. A cache under "_none" can't be busted
  // by any of the org-scoped helpers, so the safer default is to just
  // read fresh (this branch is rare — multi-org user with no picked
  // company yet).
  const loader = async () => {
    const [employee, claims] = await Promise.all([
      claimRepository.getEmployeeWithProfile(session.email, orgId),
      claimRepository.getClaimsByEmployee(session.email, orgId),
    ])
    if (!employee) return null
    const organization = employee.organizationId
      ? await organizationRepository.getOrganizationById(employee.organizationId)
      : null
    return buildEmployeeDashboard(employee, claims, organization ?? undefined)
  }
  if (!orgId) return loader()
  return getOrSetCache(
    key("org", orgId, "user", session.userId, "claims", "dashboard"),
    60,
    loader,
  )
}

export async function getEmployeeClaimHistory(): Promise<ClaimRecord[] | null> {
  const session = await requireEmployeeSession()
  if (!session) return null

  const orgId = resolveActiveOrgId(session)
  if (!orgId) return claimRepository.getClaimsByEmployee(session.email, orgId)
  return getOrSetCache(
    key("org", orgId, "user", session.userId, "claims", "history"),
    60,
    () => claimRepository.getClaimsByEmployee(session.email, orgId),
  )
}

export async function getEmployeeAccount(): Promise<EmployeeAccountData | null> {
  const session = await requireEmployeeSession()
  if (!session) return null

  // Profile + org change rarely (hierarchy edits, org settings). 30-
  // min TTL — the "config" namespace is busted by `bustOrgConfigCaches`
  // on every hierarchy/settings change, so the TTL only matters if a
  // bust slips past (which our audit covered).
  const orgId = resolveActiveOrgId(session)
  const loader = async () => {
    const employee = await claimRepository.getEmployeeWithProfile(
      session.email,
      orgId,
    )
    if (!employee) return null
    const organization = employee.organizationId
      ? await organizationRepository.getOrganizationById(employee.organizationId)
      : null
    return {
      employee,
      organization: organization ?? undefined,
      preferences: {
        notifications: true,
        weeklyDigest: true,
        expensePolicyVersion: "2026.1",
      },
    }
  }
  if (!orgId) return loader()
  return getOrSetCache(
    key("org", orgId, "user", session.userId, "config", "account"),
    1800,
    loader,
  )
}

export async function getEmployeeClaimSubmissionData(): Promise<EmployeeClaimSubmissionData | null> {
  const session = await requireEmployeeSession()
  if (!session) return null

  // 30-min TTL. Although this includes spend-limit math derived from
  // recent claims, `bustClaimCaches` busts this key on every claim
  // mutation so the next form load is always fresh. The longer TTL is
  // safe because the bust is the primary invalidation path, not the
  // TTL.
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return loadEmployeeClaimSubmissionData(session.email, orgId)
  return getOrSetCache(
    key("org", orgId, "user", session.userId, "config", "claim-submission-data"),
    1800,
    () => loadEmployeeClaimSubmissionData(session.email, orgId),
  )
}

async function loadEmployeeClaimSubmissionData(
  email: string,
  organizationId?: string,
): Promise<EmployeeClaimSubmissionData | null> {
  const employee = await claimRepository.getEmployeeWithProfile(
    email,
    organizationId,
  )
  if (!employee) return null

  if (!employee.organizationId) {
    return {
      employee,
      chartAccounts: [],
      mileageAccounts: [],
      bankAccounts: [],
      employeeProjects: [],
    }
  }

  const employeeUserId = await claimRepository.getUserId(
    employee.email,
    "EMPLOYEE",
  )

  const [organization, chartAccounts, mileageAccounts, bankAccounts, employeeProjects] = await Promise.all([
    organizationRepository.getOrganizationById(employee.organizationId),
    organizationRepository.getSelectableChartAccountsForEmployee({
      organizationId: employee.organizationId,
      xeroConnectionId: employee.xeroConnectionId,
    }),
    organizationRepository.getMileageChartAccountsForEmployee({
      organizationId: employee.organizationId,
      xeroConnectionId: employee.xeroConnectionId,
    }),
    organizationRepository.getSelectedBankAccountsForOrganization({
      organizationId: employee.organizationId,
      xeroConnectionId: employee.xeroConnectionId,
    }),
    employeeUserId
      ? organizationRepository.getProjectsForEmployee(employeeUserId)
      : Promise.resolve<Array<{ id: string; name: string }>>([]),
  ])

  // Decorate every account with its remaining-limit info so the form can show
  // an inline hint. Previously this was a per-account `getRemainingLimit` call
  // — with 30+ selectable accounts the form took 30+ DB round-trips on load.
  // Now we group accounts by (period, scope), run one batched aggregate per
  // bucket, then look up each account's used-amount in O(1).
  const decoratedChart = await decorateAccountsWithLimits({
    accounts: chartAccounts,
    organizationId: employee.organizationId,
    employeeId: employeeUserId ?? undefined,
  })
  const decoratedMileage = await decorateAccountsWithLimits({
    accounts: mileageAccounts,
    organizationId: employee.organizationId,
    employeeId: employeeUserId ?? undefined,
  })

  return {
    employee,
    organization: organization ?? undefined,
    chartAccounts: decoratedChart,
    mileageAccounts: decoratedMileage,
    bankAccounts,
    employeeProjects,
    claimRunPreview: organization
      ? buildClaimRunPreview({
          submittedAt: new Date(),
          claimCutoffDay: organization.claimCutoffDay,
        })
      : undefined,
  }
}

/**
 * Compute "X used of Y remaining" for a list of accounts using **at most one
 * DB query per (period, scope) bucket**, instead of one per account.
 *
 * For each (period, scope) combination present in the accounts list:
 *  - resolve the period window once (always the same `refDate = now`)
 *  - run a single grouped aggregate filtering on `chartOfAccountId IN (…)`
 *  - look up each account's used-amount from the resulting Map
 *
 * Accounts without a configured limit get `remainingLimit: null`.
 */
async function decorateAccountsWithLimits(input: {
  accounts: ChartOfAccountOption[]
  organizationId: string
  employeeId?: string
}): Promise<ChartAccountWithRemainingLimit[]> {
  const { accounts, organizationId, employeeId } = input
  const refDate = new Date()

  // PER_CLAIM has no historical sum — handled inline below without a query.
  // For MONTHLY / YEARLY we group by (period, scope) and run one query each.
  type Bucket = { period: "MONTHLY" | "YEARLY"; scope: "PER_EMPLOYEE" | "ORG_WIDE" }
  const bucketKey = (b: Bucket) => `${b.period}|${b.scope}`
  const bucketsByKey = new Map<string, { bucket: Bucket; accountIds: string[] }>()

  for (const account of accounts) {
    if (
      account.limitAmount == null ||
      account.limitPeriod == null ||
      account.limitScope == null
    ) {
      continue
    }
    if (account.limitPeriod === "PER_CLAIM") continue
    const bucket: Bucket = {
      period: account.limitPeriod,
      scope: account.limitScope,
    }
    const key = bucketKey(bucket)
    const entry = bucketsByKey.get(key)
    if (entry) {
      entry.accountIds.push(account.id)
    } else {
      bucketsByKey.set(key, { bucket, accountIds: [account.id] })
    }
  }

  // Run one aggregate per bucket in parallel.
  const usedById = new Map<string, number>()
  if (employeeId || true) {
    await Promise.all(
      Array.from(bucketsByKey.values()).map(async ({ bucket, accountIds }) => {
        const { start, end } = getPeriodWindow(bucket.period, refDate)
        const sums = await claimRepository.sumClaimsByAccountForLimits({
          organizationId,
          accountIds,
          employeeId: bucket.scope === "PER_EMPLOYEE" ? employeeId : undefined,
          periodStart: start,
          periodEnd: end,
        })
        for (const [accountId, used] of sums) {
          usedById.set(accountId, used)
        }
      })
    )
  }

  return accounts.map((account) => {
    if (
      account.limitAmount == null ||
      account.limitPeriod == null ||
      account.limitScope == null
    ) {
      return { ...account, remainingLimit: null }
    }
    if (account.limitPeriod === "PER_CLAIM") {
      return {
        ...account,
        remainingLimit: {
          limit: account.limitAmount,
          used: 0,
          remaining: account.limitAmount,
          period: account.limitPeriod,
          scope: account.limitScope,
        },
      }
    }
    const used = usedById.get(account.id) ?? 0
    return {
      ...account,
      remainingLimit: {
        limit: account.limitAmount,
        used,
        remaining: Math.max(0, account.limitAmount - used),
        period: account.limitPeriod,
        scope: account.limitScope,
      },
    }
  })
}
