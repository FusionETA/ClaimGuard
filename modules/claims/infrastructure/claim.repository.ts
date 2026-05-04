import "server-only"

import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { buildInitials } from "@/lib/utils"
import type { Prisma } from "@/generated/prisma/client"
import { mapChartAccount } from "@/modules/organization/infrastructure/chart-account.mapper"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"
import {
  resolveAssignedProjects,
  resolveEmployeePayoutMethod,
  resolvePrimaryProjectName,
} from "@/modules/organization/domain/models"
import { decideNextClaimStatus } from "@/modules/claims/domain/models"
import type {
  AdminProfile,
  ApprovalStepInfo,
  ApprovalStepState,
  ClaimRecord,
  ClaimStatus,
  ClaimType,
  PaymentType,
  PendingApproverInfo,
  PortalUser,
} from "@/modules/claims/domain/models"

type PrismaUser = {
  id?: string
  name: string
  email: string
  role: string
  organizationId?: string | null
  organization?: {
    id: string
    name: string
    claimCutoffDay: number
  } | null
  employeeProfile: {
    employeeId: string
    project: string
    jobTitle: string
    supervisorId: string | null
    projectAssignments?: Array<{
      project: {
        id: string
        name: string
      }
    }>
    supervisor?: {
      name: string
      email: string
    } | null
    payoutMethod: string | null
    preferredCurrency: string
    xeroConnectionId?: string | null
    xeroConnection?: { tenantName: string } | null
  } | null
}

type PrismaChartAccount = {
  id: string
  code: string
  name: string
  type: string | null
  status: string | null
  isSelectable: boolean
  isBankAccount: boolean
  isCustom: boolean
  isDisabled: boolean
  xeroConnectionId: string | null
  limitAmount?: unknown
  limitPeriod?: string | null
  limitScope?: string | null
  allowMileageClaim?: boolean | null
  mileageRate?: unknown
}

type PrismaClaim = {
  id: string
  claimNumber: string
  title: string
  description: string
  amount: { toString(): string } | number | string
  currency: string
  spentAt: Date
  submittedAt: Date
  claimRunMonth: Date | null
  status: string
  paymentType: string
  payViaAccountId?: string | null
  claimType?: string | null
  receiptUrl: string | null
  reviewNotes: string | null
  reviewedAt: Date | null
  reviewerId: string | null
  reviewerRole: string | null
  employeeId: string
  distance?: { toString(): string } | number | string | null
  mileageOriginAddress?: string | null
  mileageDestinationAddress?: string | null
  mileageRateUsed?: { toString(): string } | number | string | null
  mileageUnitUsed?: string | null
  reviewer: { name: string } | null
  organization: { name: string } | null
  chartOfAccount: PrismaChartAccount | null
  payViaAccount?: PrismaChartAccount | null
  employee: PrismaUser
}

type ApprovalChainRow = {
  step: number
  approverId: string
  approver: {
    id: string
    name: string
    email: string
    role: string
  }
}

/**
 * Compute the approval chain display state for a single claim.
 * Returns undefined if the employee has no chain configured (legacy path).
 *
 * Chain state semantics:
 * - SUBMITTED               → step 1 is "current", later steps "upcoming"
 * - PENDING (no reviewedAt) → step 1 is "current" (legacy)
 * - PENDING (reviewedAt set)→ step 1 "approved", step 2 "current", later "upcoming"
 * - APPROVED/REVIEWED       → all steps "approved"
 * - REJECTED                → reviewer's step "rejected", earlier "approved",
 *                              later "skipped"
 */
function buildApprovalChainState(
  steps: ApprovalChainRow[],
  claim: {
    status: string
    reviewedAt: Date | null
    reviewerId: string | null
  }
): { chain: ApprovalStepInfo[]; pending?: PendingApproverInfo } | undefined {
  if (steps.length === 0) return undefined

  const sorted = [...steps].sort((a, b) => a.step - b.step)
  const totalSteps = sorted.length

  // Find which chain step corresponds to the most recent reviewer (if any).
  // Locating the reviewer in the chain is how we know how many supervisor
  // steps have completed — the previous heuristic ("alreadyReviewedOnce")
  // assumed at most a 2-step chain and broke for 3+. Now we walk to the
  // exact step the reviewer occupied and treat everything ≤ that as
  // approved.
  const reviewedStepIdx =
    claim.reviewerId !== null
      ? sorted.findIndex((s) => s.approverId === claim.reviewerId)
      : -1

  // Determine the "current" step number — i.e. who's the next supervisor
  // expected to act. A `currentStep` greater than the last step in the
  // chain means every supervisor in the chain has approved (the claim is
  // either fully done or sitting in PENDING awaiting the admin's final
  // approval).
  let currentStep: number
  if (claim.status === "SUBMITTED") {
    currentStep = sorted[0]!.step
  } else if (claim.status === "PENDING") {
    if (reviewedStepIdx >= 0) {
      const next = sorted[reviewedStepIdx + 1]
      // No next chain step → claim is now waiting for admin (no supervisor
      // is "current" in the chain). Push currentStep past the end so every
      // chain row falls into the "approved" branch below.
      currentStep = next ? next.step : sorted[totalSteps - 1]!.step + 1
    } else {
      // No previous review yet → first supervisor is current.
      currentStep = sorted[0]!.step
    }
  } else if (claim.status === "APPROVED" || claim.status === "REVIEWED") {
    currentStep = sorted[totalSteps - 1]!.step + 1
  } else if (claim.status === "REJECTED") {
    const rejectedAt = sorted.find((s) => s.approverId === claim.reviewerId)
    currentStep = rejectedAt?.step ?? sorted[0]!.step
  } else {
    currentStep = sorted[0]!.step
  }

  const chain: ApprovalStepInfo[] = sorted.map((row) => {
    let state: ApprovalStepState
    if (claim.status === "REJECTED") {
      if (row.step < currentStep) state = "approved"
      else if (row.step === currentStep) state = "rejected"
      else state = "skipped"
    } else if (row.step < currentStep) {
      state = "approved"
    } else if (row.step === currentStep) {
      state = "current"
    } else {
      state = "upcoming"
    }

    return {
      step: row.step,
      approverId: row.approverId,
      name: row.approver.name,
      email: row.approver.email,
      role: row.approver.role as ApprovalStepInfo["role"],
      state,
    }
  })

  const currentEntry = chain.find((c) => c.state === "current")
  const pending: PendingApproverInfo | undefined = currentEntry
    ? {
        approverId: currentEntry.approverId,
        name: currentEntry.name,
        email: currentEntry.email,
        step: currentEntry.step,
        totalSteps,
      }
    : undefined

  return { chain, pending }
}

export type CreateClaimData = {
  claimNumber: string
  title: string
  description: string
  amount: string
  currency: string
  spentAt: Date
  receiptUrl?: string
  organizationId: string
  chartOfAccountId: string
  claimRunMonth: Date
  employeeId: string
  reviewerId: string | null
  paymentType: PaymentType
  payViaAccountId?: string | null
  // Claim-type + mileage snapshot fields. EXPENSE is the default and leaves
  // the mileage columns null.
  claimType?: "EXPENSE" | "MILEAGE"
  distance?: string
  mileageOriginAddress?: string
  mileageDestinationAddress?: string
  mileageRateUsed?: string
  mileageUnitUsed?: "KM" | "MILE"
}

export type ReviewClaimData = {
  claimId: string
  status: "APPROVED" | "REJECTED"
  reviewNotes?: string
  reviewerId: string
  supervisorOnly?: boolean
  /**
   * Optional COA override — admins can swap the chart of account when
   * giving final review (e.g. recoding a misclassified expense). Ignored
   * on the supervisor branch.
   */
  chartOfAccountId?: string
}

export type ReviewClaimResult =
  | {
      ok: true
      claimId: string
      employeeEmail: string
      employeeUserId: string
      claimTitle: string
      claimStatus: ClaimStatus
    }
  | {
      ok: false
      error: "DB_UNAVAILABLE" | "NOT_FOUND" | "NOT_ACTIONABLE"
    }

export type ClaimForXeroSync = {
  id: string
  claimNumber: string
  title: string
  description: string
  amount: number
  currency: string
  spentAt: Date
  xeroBillId: string | null
  chartOfAccount?: {
    code: string
    name: string
  } | null
  employee: {
    name: string
    email: string
  }
}

function mapUser(user: PrismaUser): PortalUser {
  const assignedProjects = resolveAssignedProjects(
    user.employeeProfile?.project,
    user.employeeProfile?.projectAssignments?.map((assignment) => assignment.project) ?? [],
  )

  return {
    name: user.name,
    email: user.email,
    employeeId: user.employeeProfile?.employeeId ?? "N/A",
    role: user.role as PortalUser["role"],
    organizationId: user.organizationId ?? undefined,
    organizationName: user.organization?.name ?? undefined,
    project: resolvePrimaryProjectName(
      user.employeeProfile?.project,
      user.employeeProfile?.projectAssignments?.map((assignment) => assignment.project) ?? [],
    ),
    projects: assignedProjects.map((project) => project.name),
    jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
    initials: buildInitials(user.name),
    supervisorEmail: user.employeeProfile?.supervisor?.email ?? undefined,
    supervisorName: user.employeeProfile?.supervisor?.name ?? undefined,
    payoutMethod: resolveEmployeePayoutMethod(
      user.role === "SUPERVISOR" ? "SUPERVISOR" : "EMPLOYEE",
      user.employeeProfile?.payoutMethod,
    ),
    preferredCurrency: user.employeeProfile?.preferredCurrency ?? "USD",
    xeroConnectionId: user.employeeProfile?.xeroConnectionId ?? undefined,
    xeroConnectionName: user.employeeProfile?.xeroConnection?.tenantName ?? undefined,
  }
}

function mapClaim(
  claim: PrismaClaim,
  chainsByEmployee?: Map<string, ApprovalChainRow[]>
): ClaimRecord {
  const chainRows = chainsByEmployee?.get(claim.employeeId) ?? []
  const chainState = buildApprovalChainState(chainRows, {
    status: claim.status,
    reviewedAt: claim.reviewedAt,
    reviewerId: claim.reviewerId,
  })

  // Admin's final review gate. A claim is ready when:
  //  - status is APPROVED and no supervisor is still expected, OR
  //  - status is SUBMITTED and the employee has no chain at all (skips the
  //    supervisor layer entirely), OR
  //  - status is legacy PENDING with the supervisor chain already complete.
  const awaitingAdminFinalApproval =
    (claim.status === "APPROVED" &&
      (chainRows.length === 0 || chainState?.pending === undefined)) ||
    (claim.status === "PENDING" &&
      (chainRows.length === 0 || chainState?.pending === undefined)) ||
    (claim.status === "SUBMITTED" && chainRows.length === 0)

  return {
    id: claim.id,
    claimNumber: claim.claimNumber,
    title: claim.title,
    description: claim.description,
    organizationName: claim.organization?.name ?? undefined,
    chartOfAccount: mapChartAccount(claim.chartOfAccount),
    payViaAccount: mapChartAccount(claim.payViaAccount),
    amount: Number(claim.amount),
    currency: claim.currency,
    spentAt: claim.spentAt.toISOString(),
    submittedAt: claim.submittedAt.toISOString(),
    claimRunMonth: claim.claimRunMonth?.toISOString(),
    status: claim.status as ClaimStatus,
    paymentType: claim.paymentType as PaymentType,
    claimType: (claim.claimType as ClaimType | null | undefined) ?? "EXPENSE",
    receiptUrl: claim.receiptUrl ?? undefined,
    reviewNotes: claim.reviewNotes ?? undefined,
    reviewerName: claim.reviewer?.name ?? undefined,
    // reviewerRole is the snapshot persisted at decision time. Cast through
    // string so historical rows (null before the column existed) stay typed.
    reviewerRole:
      claim.reviewerRole === "SUPERVISOR" || claim.reviewerRole === "ADMIN"
        ? claim.reviewerRole
        : undefined,
    reviewedAt: claim.reviewedAt?.toISOString(),
    distance: toNumber(claim.distance ?? null),
    mileageOriginAddress: claim.mileageOriginAddress ?? undefined,
    mileageDestinationAddress: claim.mileageDestinationAddress ?? undefined,
    mileageRateUsed: toNumber(claim.mileageRateUsed ?? null),
    mileageUnitUsed:
      claim.mileageUnitUsed === "KM" || claim.mileageUnitUsed === "MILE"
        ? claim.mileageUnitUsed
        : undefined,
    employee: mapUser(claim.employee),
    pendingApprover: chainState?.pending,
    approvalChain: chainState?.chain,
    awaitingAdminFinalApproval,
  }
}

const claimInclude = {
  organization: true,
  chartOfAccount: true,
  payViaAccount: true,
  employee: {
    include: {
      organization: true,
      employeeProfile: {
        include: {
          projectAssignments: {
            include: {
              project: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
          supervisor: true,
          xeroConnection: { select: { tenantName: true } },
        },
      },
    },
  },
  reviewer: true,
} as const

export const claimRepository = {
  async getEmployeeWithProfile(email: string): Promise<PortalUser | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: { email, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
      include: {
        organization: true,
        employeeProfile: {
          include: {
            projectAssignments: {
              include: {
                project: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            supervisor: true,
            xeroConnection: { select: { tenantName: true } },
          },
        },
      },
    })

    return row ? mapUser(row) : null
  },

  async getAdminProfile(email: string): Promise<AdminProfile | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: { email, role: "ADMIN" },
      include: {
        organization: true,
      },
    })

    if (!row) return null

    return {
      name: row.name,
      email: row.email,
      role: "Administrator",
      initials: buildInitials(row.name),
      organizationId: row.organizationId ?? undefined,
      organizationName: row.organization?.name ?? undefined,
    }
  },

  async getClaimsByEmployee(email: string): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: { employee: { email } },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    return rows.map((row) => mapClaim(row))
  },

  async getClaimsForSupervisor(email: string): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const supervisor = await prisma.user.findFirst({
      where: { email, role: "SUPERVISOR" },
      select: { id: true, organizationId: true },
    })

    if (!supervisor) return []

    // Look up the approval chain steps where this supervisor is an approver.
    // Step 1 → they see SUBMITTED claims (freshly submitted, awaiting first review).
    // Step 2+ → they see PENDING claims (already passed the previous layer).
    const chainSteps = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisor.id },
      select: { employeeId: true, step: true },
    })

    if (chainSteps.length > 0) {
      const employeeIds = [...new Set(chainSteps.map((step) => step.employeeId))]
      const chainRows = await prisma.approvalChainStep.findMany({
        where: { employeeId: { in: employeeIds } },
        select: { employeeId: true, step: true, approverId: true },
      })
      const approverByEmployeeStep = new Map(
        chainRows.map((step) => [`${step.employeeId}:${step.step}`, step.approverId])
      )

      // Build per-employee OR conditions: match the claim's employeeId and the
      // correct status for this supervisor's layer in that employee's chain.
      // Step 1 → SUBMITTED or PENDING with no prior review (legacy claims
      //           created before status was explicitly SUBMITTED on creation).
      // Step 2+ → PENDING whose last reviewer is the previous chain step.
      // That prevents a supervisor from seeing the same claim as still
      // reviewable after they have already approved it.
      // Build typed OR conditions. Explicit ClaimStatus[] cast is required
      // because Prisma's generated type expects a mutable array, not readonly.
      const actionableConditions: Prisma.ClaimWhereInput[] = []
      for (const { employeeId, step } of chainSteps) {
        if (step === 1) {
          actionableConditions.push({
            employeeId,
            status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
            reviewedAt: null,
          })
          continue
        }

        const previousApproverId = approverByEmployeeStep.get(`${employeeId}:${step - 1}`)
        if (!previousApproverId) continue

        actionableConditions.push({
          employeeId,
          status: { in: ["PENDING"] as ClaimStatus[] },
          reviewerId: previousApproverId,
          reviewerRole: "SUPERVISOR",
        })
      }

      if (actionableConditions.length === 0) return []

      const rows = await prisma.claim.findMany({
        where: { OR: actionableConditions },
        include: claimInclude,
        orderBy: { submittedAt: "desc" },
      })

      return rows.map((row) => mapClaim(row))
    }

    // ── Legacy fallback ──────────────────────────────────────────────────────
    // Employees that pre-date ApprovalChainStep still have supervisorId set.
    // Treat them as a 1-step chain: show SUBMITTED or unreviewed PENDING claims.
    const rows = await prisma.claim.findMany({
      where: {
        status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
        reviewedAt: null,
        organizationId: supervisor.organizationId ?? undefined,
        employee: {
          employeeProfile: {
            supervisorId: supervisor.id,
          },
        },
      },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    return rows.map((row) => mapClaim(row))
  },

  /**
   * Count-only variant of `getClaimsForSupervisor`. Avoids hydrating the full
   * claim payload (mapper + chain join + employee join) just to compute a
   * badge number. Used by the supervisor dashboard's "Awaiting your review"
   * indicator, which gets re-fetched on every page poll.
   */
  /**
   * Lightweight lookup for sending push notifications about a claim — returns
   * just the employee user-id and the claim title, without hydrating the full
   * claim payload.
   */
  async getClaimNotificationSnapshot(
    claimId: string
  ): Promise<{ employeeId: string; title: string } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      select: { employeeId: true, title: true },
    })
    return claim ?? null
  },

  async countPendingForSupervisor(email: string): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) return 0

    const supervisor = await prisma.user.findFirst({
      where: { email, role: "SUPERVISOR" },
      select: { id: true, organizationId: true },
    })

    if (!supervisor) return 0

    const chainSteps = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisor.id },
      select: { employeeId: true, step: true },
    })

    if (chainSteps.length > 0) {
      const employeeIds = [...new Set(chainSteps.map((step) => step.employeeId))]
      const chainRows = await prisma.approvalChainStep.findMany({
        where: { employeeId: { in: employeeIds } },
        select: { employeeId: true, step: true, approverId: true },
      })
      const approverByEmployeeStep = new Map(
        chainRows.map((step) => [`${step.employeeId}:${step.step}`, step.approverId])
      )

      const conditions: Prisma.ClaimWhereInput[] = []
      for (const { employeeId, step } of chainSteps) {
        if (step === 1) {
          conditions.push({
            employeeId,
            status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
            reviewedAt: null,
          })
          continue
        }

        const previousApproverId = approverByEmployeeStep.get(`${employeeId}:${step - 1}`)
        if (!previousApproverId) continue

        conditions.push({
          employeeId,
          status: { in: ["PENDING"] as ClaimStatus[] },
          reviewerId: previousApproverId,
          reviewerRole: "SUPERVISOR",
        })
      }

      if (conditions.length === 0) return 0

      return prisma.claim.count({ where: { OR: conditions } })
    }

    return prisma.claim.count({
      where: {
        status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
        reviewedAt: null,
        organizationId: supervisor.organizationId ?? undefined,
        employee: {
          employeeProfile: { supervisorId: supervisor.id },
        },
      },
    })
  },

  async getClaimsForOrganization(
    organizationId: string,
    xeroConnectionId?: string
  ): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId,
        ...(xeroConnectionId
          ? { employee: { employeeProfile: { xeroConnectionId } } }
          : {}),
      },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    // Batch-load approval chains for every distinct employee in one query so
    // the admin queue can render "Awaiting <approver>" without N+1 lookups.
    const employeeIds = Array.from(new Set(rows.map((r) => r.employeeId)))
    const chainRows =
      employeeIds.length === 0
        ? []
        : await prisma.approvalChainStep.findMany({
            where: { employeeId: { in: employeeIds } },
            include: {
              approver: {
                select: { id: true, name: true, email: true, role: true },
              },
            },
            orderBy: [{ employeeId: "asc" }, { step: "asc" }],
          })

    const chainsByEmployee = new Map<string, ApprovalChainRow[]>()
    for (const row of chainRows) {
      const list = chainsByEmployee.get(row.employeeId) ?? []
      list.push({
        step: row.step,
        approverId: row.approverId,
        approver: row.approver,
      })
      chainsByEmployee.set(row.employeeId, list)
    }

    return rows.map((row) => mapClaim(row, chainsByEmployee))
  },

  async getFirstAdminId(organizationId?: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: {
        role: "ADMIN",
        ...(organizationId ? { organizationId } : {}),
      },
      orderBy: { createdAt: "asc" },
    })
    return row?.id ?? null
  },

  async getUserId(
    email: string,
    role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN"
  ): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where:
        role === "EMPLOYEE"
          ? { email, role: { in: ["EMPLOYEE", "SUPERVISOR"] } }
          : { email, role },
    })
    return row?.id ?? null
  },

  async getSupervisorIdForUser(userId: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.employeeProfile.findUnique({
      where: { userId },
      select: { supervisorId: true },
    })

    return row?.supervisorId ?? null
  },

  async createClaim(data: CreateClaimData): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    await prisma.claim.create({
      data: {
        claimNumber: data.claimNumber,
        title: data.title,
        description: data.description,
        category: "OTHER",
        claimType: data.claimType ?? "EXPENSE",
        status: "SUBMITTED",
        organizationId: data.organizationId,
        chartOfAccountId: data.chartOfAccountId,
        amount: data.amount,
        currency: data.currency,
        spentAt: data.spentAt,
        claimRunMonth: data.claimRunMonth,
        receiptUrl: data.receiptUrl,
        employeeId: data.employeeId,
        reviewerId: data.reviewerId,
        paymentType: data.paymentType,
        payViaAccountId: data.payViaAccountId ?? null,
        distance: data.distance,
        mileageOriginAddress: data.mileageOriginAddress,
        mileageDestinationAddress: data.mileageDestinationAddress,
        mileageRateUsed: data.mileageRateUsed,
        mileageUnitUsed: data.mileageUnitUsed,
      },
    })
    return true
  },

  /**
   * Sum claim amounts that count against an account's spend limit. Includes
   * claims in any non-terminal status (SUBMITTED/PENDING/APPROVED) — only
   * REJECTED claims are excluded.
   *
   * - employeeId omitted ⇒ org-wide sum (use for ORG_WIDE limits).
   * - excludeClaimId lets callers ignore the current claim when re-checking
   *   on edit (not used yet but cheap to support).
   */
  async sumClaimsForLimit(data: {
    organizationId: string
    chartOfAccountId: string
    employeeId?: string
    periodStart: Date
    periodEnd: Date
    excludeClaimId?: string
  }): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) return 0

    const result = await prisma.claim.aggregate({
      _sum: { amount: true },
      where: {
        organizationId: data.organizationId,
        chartOfAccountId: data.chartOfAccountId,
        status: { not: "REJECTED" },
        spentAt: { gte: data.periodStart, lt: data.periodEnd },
        ...(data.employeeId ? { employeeId: data.employeeId } : {}),
        ...(data.excludeClaimId ? { id: { not: data.excludeClaimId } } : {}),
      },
    })

    return toNumber(result._sum.amount, 0)
  },

  /**
   * Batched version of `sumClaimsForLimit` for the employee claim form, where
   * we want totals for many accounts at once (one for each account that has
   * a limit configured). Returns a `Map<chartOfAccountId, number>` so the
   * service can look up each account's used-amount in O(1).
   *
   * Implementation note: a single grouped aggregate is much cheaper than
   * N separate aggregate queries — one DB round trip vs N. When `accountIds`
   * is empty, returns an empty map without hitting the DB.
   */
  async sumClaimsByAccountForLimits(data: {
    organizationId: string
    accountIds: string[]
    employeeId?: string
    periodStart: Date
    periodEnd: Date
  }): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    if (data.accountIds.length === 0) return result

    const prisma = getPrismaClient()
    if (!prisma) return result

    const rows = await prisma.claim.groupBy({
      by: ["chartOfAccountId"],
      _sum: { amount: true },
      where: {
        organizationId: data.organizationId,
        chartOfAccountId: { in: data.accountIds },
        status: { not: "REJECTED" },
        spentAt: { gte: data.periodStart, lt: data.periodEnd },
        ...(data.employeeId ? { employeeId: data.employeeId } : {}),
      },
    })

    for (const row of rows) {
      if (row.chartOfAccountId == null) continue
      result.set(row.chartOfAccountId, toNumber(row._sum.amount, 0))
    }
    return result
  },

  async reviewClaim(data: ReviewClaimData): Promise<ReviewClaimResult> {
    const prisma = getPrismaClient()
    if (!prisma) {
      return { ok: false, error: "DB_UNAVAILABLE" }
    }

    const existingClaim = await prisma.claim.findUnique({
      where: { id: data.claimId },
      select: {
        id: true,
        title: true,
        status: true,
        reviewedAt: true,
        reviewerId: true,
        employeeId: true,
        paymentType: true,
        employee: {
          select: {
            email: true,
            employeeProfile: {
              select: {
                supervisorId: true,
              },
            },
          },
        },
      },
    })

    if (!existingClaim) {
      return { ok: false, error: "NOT_FOUND" }
    }

    if (
      data.supervisorOnly &&
      existingClaim.status !== "SUBMITTED" &&
      existingClaim.status !== "PENDING"
    ) {
      return { ok: false, error: "NOT_ACTIONABLE" }
    }

    if (
      !data.supervisorOnly &&
      existingClaim.status !== "SUBMITTED" &&
      existingClaim.status !== "PENDING" &&
      existingClaim.status !== "APPROVED"
    ) {
      return { ok: false, error: "NOT_ACTIONABLE" }
    }

    let persistedStatus: ClaimStatus

    if (data.supervisorOnly) {
      // Load the employee's approval chain to verify the reviewer is the
      // expected next supervisor in line. When the last supervisor approves,
      // the claim moves to APPROVED and becomes ready for admin review.
      const chain = await prisma.approvalChainStep.findMany({
        where: { employeeId: existingClaim.employeeId },
        orderBy: { step: "asc" },
      })

      let supervisorChainComplete = true

      if (chain.length > 0) {
        const reviewerStep = chain.find((s) => s.approverId === data.reviewerId)
        const reviewedStep =
          existingClaim.reviewerId !== null
            ? chain.find((s) => s.approverId === existingClaim.reviewerId)
            : undefined

        let expectedStep = chain[0]!.step
        if (existingClaim.status === "PENDING" && existingClaim.reviewedAt !== null) {
          if (!reviewedStep) {
            return { ok: false, error: "NOT_FOUND" }
          }
          expectedStep = reviewedStep.step + 1
        }

        if (!reviewerStep || reviewerStep.step !== expectedStep) {
          return { ok: false, error: "NOT_FOUND" }
        }

        supervisorChainComplete = reviewerStep.step === chain[chain.length - 1]!.step
      } else {
        // Legacy path: no chain steps — fall back to supervisorId check.
        if (existingClaim.employee.employeeProfile?.supervisorId !== data.reviewerId) {
          return { ok: false, error: "NOT_FOUND" }
        }
      }

      const nextStatus = decideNextClaimStatus({
        decision: data.status,
        reviewerKind: "SUPERVISOR",
        supervisorChainComplete,
      })
      persistedStatus = nextStatus

      await prisma.claim.update({
        where: { id: data.claimId },
        data: {
          status: nextStatus,
          reviewNotes: data.reviewNotes || null,
          reviewedAt: new Date(),
          reviewerId: data.reviewerId,
          // Snapshot the reviewer's role at decision time so the UI can
          // filter and label "approved/rejected by supervisor" later.
          reviewerRole: "SUPERVISOR",
        },
      })
    } else {
      // Admin review — always terminal. Admin can also swap the chart of
      // account at this point (e.g. recoding a misfiled expense) by passing
      // `chartOfAccountId`. We only honor the COA override on approve; on
      // reject it would be a rejected claim with a freshly-changed COA,
      // which is confusing.
      const finalStatus = decideNextClaimStatus({
        decision: data.status,
        reviewerKind: "ADMIN",
      })
      persistedStatus = finalStatus

      await prisma.claim.update({
        where: { id: data.claimId },
        data: {
          status: finalStatus,
          reviewNotes: data.reviewNotes || null,
          reviewedAt: new Date(),
          reviewerId: data.reviewerId,
          reviewerRole: "ADMIN",
          ...(finalStatus === "REVIEWED" && data.chartOfAccountId
            ? { chartOfAccountId: data.chartOfAccountId }
            : {}),
        },
      })
    }

    return {
      ok: true,
      claimId: existingClaim.id,
      employeeEmail: existingClaim.employee.email,
      employeeUserId: existingClaim.employeeId,
      claimTitle: existingClaim.title,
      claimStatus: persistedStatus,
    }
  },

  async getClaimForXeroSync(claimId: string): Promise<ClaimForXeroSync | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      select: {
        id: true,
        claimNumber: true,
        title: true,
        description: true,
        amount: true,
        currency: true,
        spentAt: true,
        xeroBillId: true,
        chartOfAccount: {
          select: {
            code: true,
            name: true,
          },
        },
        employee: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    })

    if (!claim) return null

    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      title: claim.title,
      description: claim.description,
      amount: Number(claim.amount),
      currency: claim.currency,
      spentAt: claim.spentAt,
      xeroBillId: claim.xeroBillId,
      chartOfAccount: claim.chartOfAccount,
      employee: claim.employee,
    }
  },

  async markClaimXeroSynced(data: {
    claimId: string
    xeroBillId: string
    xeroBillRef?: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        xeroBillId: data.xeroBillId,
        xeroBillRef: data.xeroBillRef ?? null,
        xeroSyncStatus: "SYNCED",
        xeroSyncError: null,
        xeroSyncedAt: new Date(),
      },
    })
  },

  async markClaimXeroError(data: {
    claimId: string
    message: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        xeroSyncStatus: "ERROR",
        xeroSyncError: data.message.slice(0, 5000),
      },
    })
  },
}
