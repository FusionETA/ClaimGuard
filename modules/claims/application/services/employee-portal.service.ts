import "server-only"

import { getEmployeeStore, clearEmployeeStore } from "@/lib/app-store"
import { loadEmployeeData } from "@/lib/load-user-data"
import { getCurrentSession } from "@/lib/auth/session"
import { isStoreExpired } from "@/lib/app-store"
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
} from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"
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
      mileageAccounts: [],
      bankAccounts: [],
    }
  }

  const employeeUserId = await claimRepository.getUserId(
    store.employee.email,
    "EMPLOYEE"
  )

  const [organization, chartAccounts, mileageAccounts, bankAccounts] =
    await Promise.all([
      organizationRepository.getOrganizationById(store.employee.organizationId),
      organizationRepository.getSelectableChartAccountsForEmployee({
        organizationId: store.employee.organizationId,
        xeroConnectionId: store.employee.xeroConnectionId,
      }),
      organizationRepository.getMileageChartAccountsForEmployee({
        organizationId: store.employee.organizationId,
        xeroConnectionId: store.employee.xeroConnectionId,
      }),
      organizationRepository.getBankAccountsForOrganization({
        organizationId: store.employee.organizationId,
        xeroConnectionId: store.employee.xeroConnectionId,
      }),
    ])

  // Decorate every account with its remaining-limit info so the form can show
  // an inline hint. Previously this was a per-account `getRemainingLimit` call
  // — with 30+ selectable accounts the form took 30+ DB round-trips on load.
  // Now we group accounts by (period, scope), run one batched aggregate per
  // bucket, then look up each account's used-amount in O(1).
  const decoratedChart = await decorateAccountsWithLimits({
    accounts: chartAccounts,
    organizationId: store.employee.organizationId,
    employeeId: employeeUserId ?? undefined,
  })
  const decoratedMileage = await decorateAccountsWithLimits({
    accounts: mileageAccounts,
    organizationId: store.employee.organizationId,
    employeeId: employeeUserId ?? undefined,
  })

  return {
    employee: store.employee,
    organization: organization ?? undefined,
    chartAccounts: decoratedChart,
    mileageAccounts: decoratedMileage,
    bankAccounts,
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
