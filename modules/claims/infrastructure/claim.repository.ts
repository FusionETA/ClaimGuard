import "server-only"

import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { buildInitials } from "@/lib/utils"

/**
 * Module-scoped Prisma accessor for the claims module. Services call
 * this instead of `getPrismaClient()` from `@/lib/prisma` so all
 * claims-related DB access flows through the infrastructure layer.
 */
export function getClaimsPrismaClient() {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured")
  return prisma
}

export function getClaimsPrismaClientSafe() {
  return getPrismaClient()
}
import type { Prisma } from "@/generated/prisma/client"
import { mapChartAccount } from "@/modules/organization/infrastructure/chart-account.mapper"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"
import {
  resolveAssignedProjects,
  resolvePrimaryProjectName,
} from "@/modules/organization/domain/models"
import { resolveModuleChain } from "@/modules/organization/application/services/approval-chain.service"
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
    jobTitle: string
    projectAssignments?: Array<{
      project: {
        id: string
        name: string
      }
    }>
    policy?: {
      salaryType: string
    } | null
    preferredCurrency: string
  } | null
  approvalChainSteps?: Array<{
    step: number
    approver: { name: string; email: string }
  }>
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
  xeroSyncStatus: string
  xeroSyncError?: string | null
  xeroSyncedAt?: Date | null
  xeroBillId?: string | null
  xeroSpendMoneyId?: string | null
  paymentType: string
  payViaAccountId?: string | null
  claimType?: string | null
  exceedsLimit?: boolean | null
  receiptUrl: string | null
  reviewNotes: string | null
  lastReviewedAt: Date | null
  lastReviewerId: string | null
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
  /// Optional free-text "who you spent with" — surfaced on review
  /// screens.
  spendingWith?: string | null
  /// Optional supporting files. Only present when the relation was
  /// included; absent on selects that didn't ask for it.
  supportingAttachments?: Array<{
    id: string
    fileName: string
    fileUrl: string | null
    xeroFileId: string | null
    mimeType: string | null
    sizeBytes: number | null
  }>
  payrollRunAttachment?: {
    payrollRunId: string
    payrollRun: {
      periodYear: number
      periodMonth: number
      status: string
      xeroSyncStatus: string
      xeroSyncedAt: Date | null
    }
  } | null
  /// Per-step audit entries. Optional because old claim selects without
  /// the include don't return them; the chain renderer treats absent
  /// entries as "legacy claim, unknown actor".
  approvalEntries?: Array<{
    stepNumber: number
    approverId: string
    decision: string
    reviewedAt: Date
    reviewNotes: string | null
  }>
}

/// Module-filtered chain step with multi-approver support. Each step
/// holds the SET of approvers eligible at that step. Any one of them
/// approving completes the step.
type GroupedChainStep = {
  step: number
  approvers: Array<{
    approverId: string
    name: string
    email: string
    role: string
  }>
}

/**
 * Compute the approval chain display state for a single claim.
 * Returns undefined if the employee has no chain configured (legacy path).
 *
 * Multi-approver semantics: when a step has N approvers and one of them
 * acts, that step becomes "approved" and the others are marked "skipped"
 * (silently removed from their queues — see `getClaimsForSupervisor`).
 * The output flattens the groups into one ApprovalStepInfo per approver
 * so existing UI code that iterates approvalChain[] continues to work.
 *
 * Chain state semantics:
 * - SUBMITTED                   → step 1 is "current", later steps "upcoming"
 * - PENDING (no lastReviewedAt) → step 1 is "current" (legacy)
 * - PENDING (lastReviewedAt set)→ step 1 "approved", step 2 "current", later "upcoming"
 * - APPROVED/REVIEWED           → all steps "approved"
 * - REJECTED                    → reviewer's step "rejected", earlier "approved",
 *                                 later "skipped"
 */
function buildApprovalChainState(
  steps: GroupedChainStep[],
  claim: {
    status: string
    lastReviewedAt: Date | null
    lastReviewerId: string | null
    /// Per-step audit entries. When present, drive the per-approver
    /// state (so we know exactly who acted at each step). When absent
    /// (legacy claims, before the audit table existed), fall back to
    /// the heuristic that "all approvers in a passed step are approved".
    approvalEntries?: Array<{
      stepNumber: number
      approverId: string
      decision: string
      reviewedAt: Date
    }>
  }
): { chain: ApprovalStepInfo[]; pending?: PendingApproverInfo } | undefined {
  if (steps.length === 0) return undefined

  const sorted = [...steps].sort((a, b) => a.step - b.step)
  const totalSteps = sorted.length

  // Index entries by (step, approverId) for O(1) lookups.
  const entryByKey = new Map<
    string,
    { decision: string; reviewedAt: Date }
  >()
  const stepsWithEntries = new Set<number>()
  for (const e of claim.approvalEntries ?? []) {
    entryByKey.set(`${e.stepNumber}::${e.approverId}`, {
      decision: e.decision,
      reviewedAt: e.reviewedAt,
    })
    stepsWithEntries.add(e.stepNumber)
  }

  // Find which chain step corresponds to the most recent reviewer (if any).
  // For multi-approver groups, the reviewer is anyone in the step's set.
  const reviewedStepIdx =
    claim.lastReviewerId !== null
      ? sorted.findIndex((s) =>
          s.approvers.some((a) => a.approverId === claim.lastReviewerId),
        )
      : -1

  // Determine the "current" step number — i.e. who's the next group of
  // approvers expected to act. currentStep beyond the last step means
  // every group has approved (claim is APPROVED awaiting admin or fully
  // done).
  let currentStep: number
  if (claim.status === "SUBMITTED") {
    currentStep = sorted[0]!.step
  } else if (claim.status === "PENDING") {
    if (reviewedStepIdx >= 0) {
      const next = sorted[reviewedStepIdx + 1]
      currentStep = next ? next.step : sorted[totalSteps - 1]!.step + 1
    } else {
      currentStep = sorted[0]!.step
    }
  } else if (claim.status === "APPROVED" || claim.status === "REVIEWED") {
    currentStep = sorted[totalSteps - 1]!.step + 1
  } else if (claim.status === "REJECTED") {
    const rejectedAt = sorted.find((s) =>
      s.approvers.some((a) => a.approverId === claim.lastReviewerId),
    )
    currentStep = rejectedAt?.step ?? sorted[0]!.step
  } else {
    currentStep = sorted[0]!.step
  }

  // Flatten groups into per-approver entries with state. Logic:
  //   - If we have an audit entry for this approver+step → use the
  //     entry's decision (APPROVED → "approved", REJECTED → "rejected")
  //     and surface its timestamp.
  //   - Else if the step has ANY entry → this approver is a peer who
  //     didn't act → "skipped".
  //   - Else (no entries for this step at all): legacy claim. If the
  //     step has been passed (step < currentStep), mark as "approved"
  //     with no timestamp (we don't know who acted). Otherwise use
  //     the position-based fallback ("current"/"upcoming"/"rejected").
  const chain: ApprovalStepInfo[] = []
  for (const group of sorted) {
    const stepHasEntries = stepsWithEntries.has(group.step)

    for (const approver of group.approvers) {
      const myEntry = entryByKey.get(`${group.step}::${approver.approverId}`)

      let entryState: ApprovalStepState
      let reviewedAt: string | undefined

      if (myEntry) {
        // Authoritative audit row — use it.
        entryState = myEntry.decision === "APPROVED" ? "approved" : "rejected"
        reviewedAt = myEntry.reviewedAt.toISOString()
      } else if (stepHasEntries) {
        // Peer in a step that someone else acted on.
        entryState = "skipped"
      } else if (claim.status === "REJECTED") {
        if (group.step < currentStep) entryState = "approved"
        else if (group.step === currentStep) entryState = "rejected"
        else entryState = "skipped"
      } else if (group.step < currentStep) {
        // Legacy passed step (no audit history). Mark as approved
        // without a timestamp — we genuinely don't know which person
        // in this group clicked Approve.
        entryState = "approved"
      } else if (group.step === currentStep) {
        entryState = "current"
      } else {
        entryState = "upcoming"
      }

      chain.push({
        step: group.step,
        approverId: approver.approverId,
        name: approver.name,
        email: approver.email,
        role: approver.role as ApprovalStepInfo["role"],
        state: entryState,
        reviewedAt,
      })
    }
  }

  // PendingApproverInfo: representative of the current step. With
  // multi-approver, we expose the FIRST approver's name as the public
  // label, with totalSteps reflecting the count of distinct steps. The
  // admin queue's "Awaiting X" badge will read this; if the user wants a
  // more nuanced display ("Awaiting any of A, B, C"), it can be done in
  // the UI by looking at the chain rows where state === "current".
  const currentGroup = sorted.find((g) => g.step === currentStep)
  const pending: PendingApproverInfo | undefined = currentGroup
    ? {
        approverId: currentGroup.approvers[0]?.approverId ?? "",
        name:
          currentGroup.approvers.length > 1
            ? `${currentGroup.approvers[0]?.name ?? "?"} +${currentGroup.approvers.length - 1}`
            : currentGroup.approvers[0]?.name ?? "?",
        email: currentGroup.approvers[0]?.email ?? "",
        step: currentGroup.step,
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
  /// Project this claim belongs to. When set, drives module-aware approval
  /// routing through the employee's team chain in this project. Null is
  /// allowed for legacy or admin-only claims that aren't project-bound.
  projectId?: string | null
  chartOfAccountId: string
  claimRunMonth: Date
  employeeId: string
  reviewerId: string | null
  paymentType: PaymentType
  payViaAccountId?: string | null
  /// True when the submitted amount blew past the account spend limit.
  /// The claim is still saved; this flag is what the admin queue reads to
  /// surface a "FLAGGED" badge.
  exceedsLimit?: boolean
  /// Xero file id when the receipt was uploaded to Xero Files. Null for
  /// receipts kept on local disk (custom-account claims).
  xeroFileId?: string | null
  // Claim-type + mileage snapshot fields. EXPENSE is the default and leaves
  // the mileage columns null.
  claimType?: "EXPENSE" | "MILEAGE"
  distance?: string
  mileageOriginAddress?: string
  mileageDestinationAddress?: string
  mileageRateUsed?: string
  mileageUnitUsed?: "KM" | "MILE"
  /// Optional free-text "who you spent with" (e.g. client / vendor
  /// name). Surfaced on the review screens; not validated server-side
  /// against any list — purely informational.
  spendingWith?: string | null
  /// Optional extra files supporting this claim (quotations, invoices,
  /// approval emails, secondary receipts). Each entry already has a
  /// resolved `fileUrl` and/or `xeroFileId` from the storage pipeline.
  /// The primary OCR'd receipt lives on `receiptUrl` + `xeroFileId` —
  /// these are EXTRAS only.
  supportingAttachments?: Array<{
    fileName: string
    fileUrl?: string | null
    xeroFileId?: string | null
    mimeType?: string | null
    sizeBytes?: number | null
  }>
}

export type ReviewClaimData = {
  claimId: string
  status: "APPROVED" | "REJECTED"
  reviewNotes?: string
  reviewerId: string
  supervisorOnly?: boolean
}

export type ReviewClaimResult =
  | {
      ok: true
      claimId: string
      employeeEmail: string
      employeeUserId: string
      claimTitle: string
      claimStatus: ClaimStatus
      /// Approvers at the NEXT chain step — populated only when a
      /// supervisor APPROVED and the claim advanced (not final, not
      /// rejected). The service notifies them so the claim appears live
      /// in their queue + bell.
      nextApproverIds?: string[]
      /// Other approvers at the step just acted on (excluding the
      /// reviewer). The service nudges them so the claim leaves their
      /// queue live once a peer has handled it.
      peerApproverIds?: string[]
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
  /// PERSONAL → posts as an awaiting-payment bill; COMPANY → posts as a
  /// Spend Money bank transaction (money already left the company bank).
  paymentType: PaymentType
  xeroBillId: string | null
  /// Set once a COMPANY claim has been posted as a Spend Money txn —
  /// mirrors xeroBillId for idempotency on that path.
  xeroSpendMoneyId: string | null
  /// For COMPANY claims: the bank account the money was paid from. The
  /// employee/admin picked this at submission (`payViaAccountId`). Null
  /// for PERSONAL claims. `code` is the Xero account code used as the
  /// BankAccount on the Spend Money transaction.
  payViaBankAccount: {
    code: string
    name: string
    xeroConnectionId: string | null
  } | null
  /// Set when the receipt was uploaded to Xero Files at submission time.
  /// When the bill/spend-money is created we associate the file so the
  /// receipt shows up in the object's Files panel in Xero.
  xeroFileId: string | null
  organizationId: string | null
  chartOfAccount?: {
    code: string
    name: string
    /// Xero AccountID (UUID). Used as the bill line's account
    /// target when the claim's expense COA is linked to a Xero
    /// connection. Null for custom (non-Xero) accounts; in that
    /// case the bill can't be created and we surface a friendly
    /// "pick a Xero-linked account" error.
    xeroAccountId: string | null
    /// Which Xero connection the COA belongs to. The bill is
    /// posted under this connection's tenant.
    xeroConnectionId: string | null
  } | null
  /// Project the claim is filed against. Surfaced on the bill line's
  /// tracking dimension when the org has a tracking category set in
  /// payroll settings.
  project: {
    name: string
  } | null
  employee: {
    name: string
    email: string
  }
  /// Supporting attachments (the optional multi-file group on the claim
  /// form, separate from the primary receipt). Synced to the Xero
  /// invoice as Related Files alongside the receipt. `xeroFileId` is
  /// null until we upload the file to Xero Files; once set, the sync
  /// just re-associates (idempotent on retry).
  supportingAttachments: Array<{
    id: string
    fileName: string
    mimeType: string | null
    fileUrl: string | null
    xeroFileId: string | null
  }>
}

function mapUser(user: PrismaUser): PortalUser {
  const assignedProjects = resolveAssignedProjects(
    user.employeeProfile?.projectAssignments?.map((assignment) => assignment.project) ?? [],
  )

  // Derive the visible "Reports to" supervisor from the first step of the
  // employee's approval chain. Multi-approver step → first listed approver.
  const sortedSteps = (user.approvalChainSteps ?? [])
    .slice()
    .sort((a, b) => a.step - b.step)
  const firstApprover = sortedSteps[0]?.approver

  return {
    name: user.name,
    email: user.email,
    employeeId: user.employeeProfile?.employeeId ?? "N/A",
    role: user.role as PortalUser["role"],
    organizationId: user.organizationId ?? undefined,
    organizationName: user.organization?.name ?? undefined,
    project: resolvePrimaryProjectName(
      user.employeeProfile?.projectAssignments?.map((assignment) => assignment.project) ?? [],
    ),
    projects: assignedProjects.map((project) => project.name),
    jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
    initials: buildInitials(user.name),
    supervisorEmail: firstApprover?.email ?? undefined,
    supervisorName: firstApprover?.name ?? undefined,
    payoutMethod:
      user.role === "SUPERVISOR"
        ? "MONTHLY_BASED"
        : user.employeeProfile?.policy?.salaryType === "MONTHLY_BASED"
          ? "MONTHLY_BASED"
          : "HOURLY",
    preferredCurrency: user.employeeProfile?.preferredCurrency ?? "USD",
    // Xero org is fixed per organization, not per employee — the
    // selectable-account lookups now scope by org, so the portal user no
    // longer needs to carry a connection id.
    xeroConnectionId: undefined,
    xeroConnectionName: undefined,
  }
}

function mapClaim(
  claim: PrismaClaim,
  chainsByEmployee?: Map<string, GroupedChainStep[]>
): ClaimRecord {
  const chainRows = chainsByEmployee?.get(claim.employeeId) ?? []
  const chainState = buildApprovalChainState(chainRows, {
    status: claim.status,
    lastReviewedAt: claim.lastReviewedAt,
    lastReviewerId: claim.lastReviewerId,
    approvalEntries: claim.approvalEntries ?? [],
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
    xeroSyncStatus:
      claim.xeroSyncStatus === "SYNCED" || claim.xeroSyncStatus === "ERROR"
        ? claim.xeroSyncStatus
        : "NOT_SYNCED",
    xeroSyncError: claim.xeroSyncError ?? undefined,
    xeroSyncedAt: claim.xeroSyncedAt?.toISOString(),
    xeroBillId: claim.xeroBillId ?? undefined,
    xeroSpendMoneyId: claim.xeroSpendMoneyId ?? undefined,
    payrollRunAttachment: claim.payrollRunAttachment
      ? {
          payrollRunId: claim.payrollRunAttachment.payrollRunId,
          periodYear: claim.payrollRunAttachment.payrollRun.periodYear,
          periodMonth: claim.payrollRunAttachment.payrollRun.periodMonth,
          status: claim.payrollRunAttachment.payrollRun.status,
          xeroSyncStatus:
            claim.payrollRunAttachment.payrollRun.xeroSyncStatus === "SYNCED" ||
            claim.payrollRunAttachment.payrollRun.xeroSyncStatus === "ERROR"
              ? claim.payrollRunAttachment.payrollRun.xeroSyncStatus
              : "NOT_SYNCED",
          xeroSyncedAt:
            claim.payrollRunAttachment.payrollRun.xeroSyncedAt?.toISOString(),
        }
      : undefined,
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
    reviewedAt: claim.lastReviewedAt?.toISOString(),
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
    exceedsLimit: claim.exceedsLimit ?? false,
    spendingWith: claim.spendingWith ?? undefined,
    // `supportingAttachments` is only populated when the query
    // included the relation. Older queries that didn't include it
    // see `undefined` here on the Prisma type, which we project to
    // an empty array further upstream when needed.
    supportingAttachments: Array.isArray(claim.supportingAttachments)
      ? claim.supportingAttachments.map((att) => ({
          id: att.id,
          fileName: att.fileName,
          fileUrl: att.fileUrl ?? undefined,
          xeroBacked: Boolean(att.xeroFileId),
          mimeType: att.mimeType ?? undefined,
          sizeBytes: att.sizeBytes ?? undefined,
        }))
      : undefined,
  }
}

const claimInclude = {
  organization: true,
  chartOfAccount: true,
  payViaAccount: true,
  payrollRunAttachment: {
    select: {
      payrollRunId: true,
      payrollRun: {
        select: {
          periodYear: true,
          periodMonth: true,
          status: true,
          xeroSyncStatus: true,
          xeroSyncedAt: true,
        },
      },
    },
  },
  // Include the supporting attachments relation so review surfaces
  // can render the file list without an extra round-trip.
  supportingAttachments: {
    orderBy: { createdAt: "asc" } as const,
  },
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
          policy: { select: { salaryType: true } },
        },
      },
      approvalChainSteps: {
        select: {
          step: true,
          approver: { select: { name: true, email: true } },
        },
        orderBy: { step: "asc" },
      },
    },
  },
  reviewer: true,
  // Per-step approval audit entries — let the chain renderer pinpoint
  // exactly which approver acted at each step, rather than guessing
  // from the latest-only `Claim.lastReviewerId` snapshot.
  approvalEntries: {
    orderBy: { reviewedAt: "asc" },
  },
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
            policy: { select: { salaryType: true } },
          },
        },
        approvalChainSteps: {
          select: {
            step: true,
            approver: { select: { name: true, email: true } },
          },
          orderBy: { step: "asc" },
        },
      },
    })

    return row ? mapUser(row) : null
  },

  async getAdminProfile(email: string): Promise<AdminProfile | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      // OWNER is an admin superset — it must resolve as an admin profile
      // too, otherwise owners get bounced from every admin page.
      where: { email, role: { in: ["ADMIN", "OWNER"] } },
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

    // Build the supervisor's actionable conditions per (employee, project)
    // tuple. Each chain row is now scoped to a team, and each team belongs
    // to one project. So a supervisor at L2 in Team A (project X) and L3
    // in Team B (project Y) sees claims for project X gated at their L2
    // step, and claims for project Y gated at their L3 step — independently.
    const candidateRows = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisor.id, teamId: { not: null } },
      select: {
        employeeId: true,
        team: { select: { id: true, projectId: true } },
      },
    })

    const actionableConditions: Prisma.ClaimWhereInput[] = []

    if (candidateRows.length > 0) {
      // Resolve filtered (grouped) chains per (employee, project). One
      // lookup per unique tuple. The supervisor's step is the step whose
      // approvers SET contains them.
      const tupleKey = (e: string, p: string) => `${e}::${p}`
      const seenTuples = new Set<string>()
      for (const r of candidateRows) {
        if (!r.team) continue
        const key = tupleKey(r.employeeId, r.team.projectId)
        if (seenTuples.has(key)) continue
        seenTuples.add(key)

        const chain = await resolveModuleChain(
          r.employeeId,
          "CLAIMS",
          r.team.projectId,
        )
        if (chain.length === 0) continue
        const supervisorEntry = chain.find((s) =>
          s.approvers.some((a) => a.approverId === supervisor.id),
        )
        if (!supervisorEntry) continue

        const baseWhere = {
          employeeId: r.employeeId,
          projectId: r.team.projectId,
        }

        if (supervisorEntry.step === 1) {
          // First step: supervisor sees SUBMITTED + unreviewed PENDING.
          actionableConditions.push({
            ...baseWhere,
            status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
            lastReviewedAt: null,
          })
          continue
        }

        // Later step: previous step's approver SET — claim's lastReviewerId
        // is in that set means previous step is done. Match any of them.
        const prevStepApprovers = chain[supervisorEntry.step - 2]?.approvers ?? []
        if (prevStepApprovers.length === 0) continue

        actionableConditions.push({
          ...baseWhere,
          status: { in: ["PENDING"] as ClaimStatus[] },
          lastReviewerId: { in: prevStepApprovers.map((a) => a.approverId) },
          reviewerRole: "SUPERVISOR",
        })
      }
    }

    // Legacy projectId-less claims: also include claims for this supervisor
    // routed via the legacy chain (teamId IS NULL on chain rows). These are
    // visible to whoever is the employee's direct supervisor today.
    const legacyChainRows = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisor.id, teamId: null },
      select: { employeeId: true, step: true },
    })
    if (legacyChainRows.length > 0) {
      for (const r of legacyChainRows) {
        if (r.step === 1) {
          actionableConditions.push({
            employeeId: r.employeeId,
            projectId: null,
            status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
            lastReviewedAt: null,
          })
        }
        // Legacy multi-step chains weren't in scope for the test data;
        // they continue working through the legacy fallback below.
      }
    }

    if (actionableConditions.length === 0) return []

    const rows = await prisma.claim.findMany({
      where: { OR: actionableConditions },
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
  /// Look up the minimum data needed to serve a Xero Files proxy request:
  /// the claim's id, employee, project, organisation, and the chart-of-
  /// account's Xero connection (so we can fetch a fresh access token for
  /// the right tenant). Returns null when no claim references this file
  /// id — caller responds with 404.
  async getClaimByXeroFileId(xeroFileId: string): Promise<{
    id: string
    employeeId: string
    projectId: string | null
    organizationId: string | null
    chartOfAccountId: string | null
    xeroConnectionId: string | null
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    // Primary receipt path — claim.xeroFileId is unique per Xero file.
    const claimRow = await prisma.claim.findFirst({
      where: { xeroFileId },
      select: {
        id: true,
        employeeId: true,
        projectId: true,
        organizationId: true,
        chartOfAccountId: true,
      },
    })

    // Supporting attachment path — the same proxy URL serves both
    // primary receipts and the extra documents the user attached.
    // Look up the parent claim via the supporting-attachment row.
    const base =
      claimRow ??
      (
        await prisma.claimSupportingAttachment.findFirst({
          where: { xeroFileId },
          select: {
            claim: {
              select: {
                id: true,
                employeeId: true,
                projectId: true,
                organizationId: true,
                chartOfAccountId: true,
              },
            },
          },
        })
      )?.claim ??
      null
    if (!base) return null

    // The org connects to at most one Xero tenant — resolve the
    // connection from the org rather than a per-row column.
    const connection = base.organizationId
      ? await prisma.xeroConnection.findFirst({
          where: { organizationId: base.organizationId },
          select: { id: true },
        })
      : null

    return {
      id: base.id,
      employeeId: base.employeeId,
      projectId: base.projectId,
      organizationId: base.organizationId,
      chartOfAccountId: base.chartOfAccountId,
      xeroConnectionId: connection?.id ?? null,
    }
  },

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

  /**
   * Count claims in the org awaiting admin attention. Used by the admin
   * Executive Overview "Review claims" quick-action badge.
   *
   * SUBMITTED  — newly submitted, awaiting first reviewer.
   * PENDING    — under supervisor chain mid-step (might still escalate
   *              to admin if no supervisor exists at this step).
   * APPROVED   — supervisor chain complete; admin must finalise (this
   *              is the admin queue). Missing this status meant the
   *              badge dropped to 0 the moment a supervisor approved,
   *              even though the admin still had work waiting.
   */
  async countPendingForOrganization(organizationId: string): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) return 0
    return prisma.claim.count({
      where: {
        organizationId,
        status: { in: ["PENDING", "SUBMITTED", "APPROVED"] },
      },
    })
  },

  async countPendingForSupervisor(email: string): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) return 0

    const supervisor = await prisma.user.findFirst({
      where: { email, role: "SUPERVISOR" },
      select: { id: true, organizationId: true },
    })

    if (!supervisor) return 0

    const candidateRows = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisor.id, teamId: { not: null } },
      select: {
        employeeId: true,
        team: { select: { id: true, projectId: true } },
      },
    })

    const conditions: Prisma.ClaimWhereInput[] = []

    if (candidateRows.length > 0) {
      const seenTuples = new Set<string>()
      for (const r of candidateRows) {
        if (!r.team) continue
        const key = `${r.employeeId}::${r.team.projectId}`
        if (seenTuples.has(key)) continue
        seenTuples.add(key)

        const chain = await resolveModuleChain(
          r.employeeId,
          "CLAIMS",
          r.team.projectId,
        )
        if (chain.length === 0) continue
        const supervisorEntry = chain.find((s) =>
          s.approvers.some((a) => a.approverId === supervisor.id),
        )
        if (!supervisorEntry) continue

        const baseWhere = {
          employeeId: r.employeeId,
          projectId: r.team.projectId,
        }
        if (supervisorEntry.step === 1) {
          conditions.push({
            ...baseWhere,
            status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
            lastReviewedAt: null,
          })
          continue
        }

        const prevStepApprovers = chain[supervisorEntry.step - 2]?.approvers ?? []
        if (prevStepApprovers.length === 0) continue

        conditions.push({
          ...baseWhere,
          status: { in: ["PENDING"] as ClaimStatus[] },
          lastReviewerId: { in: prevStepApprovers.map((a) => a.approverId) },
          reviewerRole: "SUPERVISOR",
        })
      }
    }

    const legacyChainRows = await prisma.approvalChainStep.findMany({
      where: { approverId: supervisor.id, teamId: null },
      select: { employeeId: true, step: true },
    })
    if (legacyChainRows.length > 0) {
      for (const r of legacyChainRows) {
        if (r.step === 1) {
          conditions.push({
            employeeId: r.employeeId,
            projectId: null,
            status: { in: ["SUBMITTED", "PENDING"] as ClaimStatus[] },
            lastReviewedAt: null,
          })
        }
      }
    }

    if (conditions.length === 0) return 0

    return prisma.claim.count({ where: { OR: conditions } })
  },

  async getClaimsForOrganization(
    organizationId: string,
  ): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId,
      },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    // Batch-load module-filtered approval chains per (employee, project)
    // tuple. Each claim has its own grouped chain (multi-approver) keyed
    // by tuple. Legacy claims with projectId=null fall through to the
    // alphabetical-first-team fallback in resolveModuleChain.
    const tupleKey = (e: string, p: string | null) => `${e}::${p ?? ""}`
    const tuples = new Map<string, { employeeId: string; projectId: string | null }>()
    for (const r of rows) {
      const k = tupleKey(r.employeeId, r.projectId)
      if (!tuples.has(k)) {
        tuples.set(k, { employeeId: r.employeeId, projectId: r.projectId })
      }
    }
    const chainByTuple = new Map<string, GroupedChainStep[]>()
    if (tuples.size > 0) {
      const resolved = await Promise.all(
        Array.from(tuples.entries()).map(async ([k, t]) => ({
          k,
          steps: await resolveModuleChain(
            t.employeeId,
            "CLAIMS",
            t.projectId ?? undefined,
          ),
        })),
      )
      for (const { k, steps } of resolved) {
        chainByTuple.set(
          k,
          steps.map((s) => ({
            step: s.step,
            approvers: s.approvers.map((a) => ({
              approverId: a.approverId,
              name: a.name,
              email: a.email,
              role: a.role,
            })),
          })),
        )
      }
    }

    return rows.map((row) => {
      const key = tupleKey(row.employeeId, row.projectId)
      const single = new Map<string, GroupedChainStep[]>()
      single.set(row.employeeId, chainByTuple.get(key) ?? [])
      return mapClaim(row, single)
    })
  },

  /**
   * Claims that are REVIEWED + PERSONAL-paid and **not yet attached
   * to a payroll run** — i.e. the work-list for the new
   * "/admin/claims/payroll-ready" page. Previously gated on
   * `xeroSyncStatus: NOT_SYNCED`; that gate is gone because Xero
   * sync has moved to a post-submit, module-gated step (or is
   * skipped entirely for orgs that don't use Xero).
   *
   * The `xeroConnectionId` parameter is retained for API compat but
   * unused — the filter no longer scopes by Xero connection. Order:
   * oldest lastReviewedAt first so longest-waiting claims surface
   * to the top of the list.
   */
  async getClaimsAwaitingSync(
    organizationId: string,
    _xeroConnectionId?: string,
  ): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId,
        status: "REVIEWED",
        // Both PERSONAL and COMPANY claims surface here. The "Ready to
        // Pay" tab splits them: PERSONAL → payroll or bill, COMPANY →
        // Spend Money.
        // Hide claims already on a payroll run — they appear under that
        // run's Reimbursements card and only re-surface if detached.
        payrollRunAttachment: { is: null },
        // Hide claims already posted to Xero (bill for PERSONAL,
        // Spend Money for COMPANY) — they're done.
        xeroBillId: null,
        xeroSpendMoneyId: null,
      },
      include: claimInclude,
      orderBy: { lastReviewedAt: "asc" },
    })

    if (rows.length === 0) return []

    // Reuse the same chain-resolver pattern used by getClaimsForOrganization
    // so the row shape matches ClaimRecord and the existing claim row UI
    // can be reused.
    const tupleKey = (e: string, p: string | null) => `${e}::${p ?? ""}`
    const tuples = new Map<string, { employeeId: string; projectId: string | null }>()
    for (const r of rows) {
      const k = tupleKey(r.employeeId, r.projectId)
      if (!tuples.has(k)) {
        tuples.set(k, { employeeId: r.employeeId, projectId: r.projectId })
      }
    }
    const chainByTuple = new Map<string, GroupedChainStep[]>()
    if (tuples.size > 0) {
      const resolved = await Promise.all(
        Array.from(tuples.entries()).map(async ([k, t]) => ({
          k,
          steps: await resolveModuleChain(
            t.employeeId,
            "CLAIMS",
            t.projectId ?? undefined,
          ),
        })),
      )
      for (const { k, steps } of resolved) {
        chainByTuple.set(
          k,
          steps.map((s) => ({
            step: s.step,
            approvers: s.approvers.map((a) => ({
              approverId: a.approverId,
              name: a.name,
              email: a.email,
              role: a.role,
            })),
          })),
        )
      }
    }

    return rows.map((row) => {
      const key = tupleKey(row.employeeId, row.projectId)
      const single = new Map<string, GroupedChainStep[]>()
      single.set(row.employeeId, chainByTuple.get(key) ?? [])
      return mapClaim(row, single)
    })
  },

  // ----------------------------------------------------------------------
  // Breakdown queries (admin "By project" view)
  // ----------------------------------------------------------------------
  //
  // Each level returns one row per project / team / member with:
  //   - totalAmount  Number of MYR/USD/etc. claimed (sum of Claim.amount)
  //   - count        How many claims roll into that bucket
  //   - statusMix    Map of ClaimStatus → count for that bucket (lets the
  //                  UI render a small status badge strip without an extra
  //                  round-trip).
  //
  // All queries are scoped by:
  //   - organizationId (claim.organizationId)
  //   - spentAt within [monthStart, monthEnd) — half-open on the right so a
  //     yyyy-mm-01 → next-yyyy-mm-01 range cleanly includes the last day.
  //
  // We deliberately ignore claims with projectId=null in the project-level
  // rollup (legacy / pre-projectId claims) — they wouldn't drill into any
  // project anyway. The dashboard total card still counts them.

  async getProjectsClaimBreakdown(input: {
    organizationId: string
    monthStart: Date
    monthEnd: Date
  }): Promise<
    Array<{
      projectId: string
      projectName: string
      totalAmount: number
      count: number
      statusMix: Record<string, number>
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // groupBy gives us count + sum per (projectId, status). We re-group
    // client-side into the desired { project, statusMix } shape.
    const groups = await prisma.claim.groupBy({
      by: ["projectId", "status"],
      where: {
        organizationId: input.organizationId,
        spentAt: { gte: input.monthStart, lt: input.monthEnd },
        projectId: { not: null },
      },
      _sum: { amount: true },
      _count: { _all: true },
    })

    if (groups.length === 0) return []

    const projectIds = Array.from(
      new Set(groups.map((g) => g.projectId as string)),
    )
    const projects = await prisma.xeroProject.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true },
    })
    const nameById = new Map(projects.map((p) => [p.id, p.name]))

    const acc = new Map<
      string,
      {
        projectId: string
        projectName: string
        totalAmount: number
        count: number
        statusMix: Record<string, number>
      }
    >()
    for (const g of groups) {
      const pid = g.projectId as string
      const existing =
        acc.get(pid) ??
        {
          projectId: pid,
          projectName: nameById.get(pid) ?? "(deleted project)",
          totalAmount: 0,
          count: 0,
          statusMix: {} as Record<string, number>,
        }
      existing.totalAmount += toNumber(g._sum.amount, 0)
      existing.count += g._count._all
      existing.statusMix[g.status] =
        (existing.statusMix[g.status] ?? 0) + g._count._all
      acc.set(pid, existing)
    }

    return Array.from(acc.values()).sort((a, b) => b.totalAmount - a.totalAmount)
  },

  async getTeamsClaimBreakdown(input: {
    organizationId: string
    projectId: string
    monthStart: Date
    monthEnd: Date
  }): Promise<
    Array<{
      teamId: string
      teamName: string
      totalAmount: number
      count: number
      statusMix: Record<string, number>
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Teams are scoped to a project. Each team has a list of employee
    // memberships (EmployeeTeamMembership). A claim belongs to a team if
    // (a) it's filed against the same projectId AND (b) the claim's
    // employee is a member of that team.
    //
    // Strategy: load the project's teams + their memberships in one shot,
    // then filter the period's claims by employeeId against each team's
    // member set. That keeps it to two queries regardless of team count.
    // Org-scope the team query through the project relation. Without
    // this, a stale `?project=` URL param from a previous active company
    // would still return that other org's teams (with empty claim
    // counts, since the claim query below IS org-scoped) — which looks
    // to the admin like "Globe has a Team A even though I never made
    // one". Cross-org team rows simply can't appear here.
    const teams = await prisma.team.findMany({
      where: {
        projectId: input.projectId,
        project: { organizationId: input.organizationId },
      },
      select: {
        id: true,
        name: true,
        memberships: { select: { employeeProfile: { select: { userId: true } } } },
      },
      orderBy: { name: "asc" },
    })
    if (teams.length === 0) return []

    const claims = await prisma.claim.findMany({
      where: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        spentAt: { gte: input.monthStart, lt: input.monthEnd },
      },
      select: {
        employeeId: true,
        amount: true,
        status: true,
      },
    })

    return teams
      .map((team) => {
        const memberIds = new Set(
          team.memberships.map((m) => m.employeeProfile.userId),
        )
        let totalAmount = 0
        let count = 0
        const statusMix: Record<string, number> = {}
        for (const c of claims) {
          if (!memberIds.has(c.employeeId)) continue
          totalAmount += toNumber(c.amount, 0)
          count += 1
          statusMix[c.status] = (statusMix[c.status] ?? 0) + 1
        }
        return {
          teamId: team.id,
          teamName: team.name,
          totalAmount,
          count,
          statusMix,
        }
      })
      .sort((a, b) => b.totalAmount - a.totalAmount)
  },

  async getMembersClaimBreakdown(input: {
    organizationId: string
    projectId: string
    teamId: string
    monthStart: Date
    monthEnd: Date
  }): Promise<
    Array<{
      employeeId: string
      employeeName: string
      employeeEmail: string
      totalAmount: number
      count: number
      statusMix: Record<string, number>
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Load just the team's members up-front so the result includes zero-
    // claim members too (helps the admin spot under-spend / no-activity).
    // Org-scope the team lookup so a stale `?team=` URL param from another
    // active company can't surface here. findFirst (not findUnique) is
    // used because the org-scope filter relies on a relation traversal
    // that findUnique doesn't support.
    const team = await prisma.team.findFirst({
      where: {
        id: input.teamId,
        projectId: input.projectId,
        project: { organizationId: input.organizationId },
      },
      select: {
        memberships: {
          select: {
            employeeProfile: {
              select: {
                userId: true,
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    })
    if (!team) return []

    const memberIds = team.memberships
      .map((m) => m.employeeProfile.user?.id)
      .filter((id): id is string => Boolean(id))

    const groups = memberIds.length
      ? await prisma.claim.groupBy({
          by: ["employeeId", "status"],
          where: {
            organizationId: input.organizationId,
            projectId: input.projectId,
            employeeId: { in: memberIds },
            spentAt: { gte: input.monthStart, lt: input.monthEnd },
          },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : []

    const userById = new Map(
      team.memberships
        .filter((m) => m.employeeProfile.user)
        .map((m) => [
          m.employeeProfile.user!.id,
          {
            id: m.employeeProfile.user!.id,
            name: m.employeeProfile.user!.name,
            email: m.employeeProfile.user!.email,
          },
        ]),
    )

    const acc = new Map<
      string,
      {
        employeeId: string
        employeeName: string
        employeeEmail: string
        totalAmount: number
        count: number
        statusMix: Record<string, number>
      }
    >()

    // Seed all members so even zero-activity ones appear.
    for (const u of userById.values()) {
      acc.set(u.id, {
        employeeId: u.id,
        employeeName: u.name,
        employeeEmail: u.email,
        totalAmount: 0,
        count: 0,
        statusMix: {},
      })
    }

    for (const g of groups) {
      const e = acc.get(g.employeeId)
      if (!e) continue
      e.totalAmount += toNumber(g._sum.amount, 0)
      e.count += g._count._all
      e.statusMix[g.status] = (e.statusMix[g.status] ?? 0) + g._count._all
    }

    return Array.from(acc.values()).sort(
      (a, b) => b.totalAmount - a.totalAmount,
    )
  },

  /**
   * Paginated claim list for the admin "Reports" page. Supports
   * optional date-range + multi-id filters on project / team / member.
   * Returns `{ rows, total, totalAmount }` so the caller can render a
   * page of results plus an "X of Y / total RM Z" summary header
   * without a second round-trip.
   *
   * `teamIds` filter joins through `Team.employees` because Claim has
   * no direct team FK — a team's "members" are EmployeeProfile rows
   * with a matching `teamId`. We resolve the matching employeeIds in
   * one extra query, then OR them into the where clause alongside the
   * supplied memberIds.
   */
  async listClaimsForReports(input: {
    organizationId: string
    /// Inclusive start date (UTC). Compared against `Claim.spentAt`.
    dateFrom?: Date
    /// Exclusive end date (UTC). Use the first instant AFTER the
    /// admin's chosen end day so claims with timestamp 23:59 still
    /// match.
    dateTo?: Date
    projectIds?: string[]
    teamIds?: string[]
    memberIds?: string[]
    /// Zero-based offset. Defaults to 0.
    skip?: number
    /// Page size. Defaults to 20.
    take?: number
  }): Promise<{ rows: ClaimRecord[]; total: number; totalAmount: number }> {
    const prisma = getPrismaClient()
    if (!prisma) return { rows: [], total: 0, totalAmount: 0 }

    // Resolve teamIds → employeeIds first, then merge with any
    // explicit memberIds. Done before the main query so the final
    // where clause is a single `employeeId: { in: [...] }`.
    let memberIdSet: Set<string> | null = null
    if (input.memberIds && input.memberIds.length > 0) {
      memberIdSet = new Set(input.memberIds)
    }
    if (input.teamIds && input.teamIds.length > 0) {
      // Team → EmployeeTeamMembership → EmployeeProfile.userId.
      // Claim.employeeId is User.id (not EmployeeProfile.id), so we
      // pull userId off the joined profile.
      const teamRows = await prisma.team.findMany({
        where: { id: { in: input.teamIds } },
        select: {
          memberships: {
            select: {
              employeeProfile: { select: { userId: true } },
            },
          },
        },
      })
      const teamMemberIds = new Set(
        teamRows.flatMap((t) =>
          t.memberships.map((m) => m.employeeProfile.userId),
        ),
      )
      if (memberIdSet) {
        // Intersect — pickedTeams ∩ pickedMembers
        const intersected = new Set<string>()
        for (const id of memberIdSet) if (teamMemberIds.has(id)) intersected.add(id)
        memberIdSet = intersected
      } else {
        memberIdSet = teamMemberIds
      }
      // If the team filter produced zero employeeIds the query is
      // statically empty — short-circuit so we don't return "all
      // claims" by accident.
      if (memberIdSet.size === 0) {
        return { rows: [], total: 0, totalAmount: 0 }
      }
    }

    const where: Prisma.ClaimWhereInput = {
      organizationId: input.organizationId,
      ...(input.dateFrom || input.dateTo
        ? {
            spentAt: {
              ...(input.dateFrom ? { gte: input.dateFrom } : {}),
              ...(input.dateTo ? { lt: input.dateTo } : {}),
            },
          }
        : {}),
      ...(input.projectIds && input.projectIds.length > 0
        ? { projectId: { in: input.projectIds } }
        : {}),
      ...(memberIdSet ? { employeeId: { in: Array.from(memberIdSet) } } : {}),
    }

    const [rows, total, sumRow] = await Promise.all([
      prisma.claim.findMany({
        where,
        include: claimInclude,
        orderBy: { spentAt: "desc" },
        skip: input.skip ?? 0,
        take: input.take ?? 20,
      }),
      prisma.claim.count({ where }),
      prisma.claim.aggregate({
        where,
        _sum: { amount: true },
      }),
    ])

    // Reuse the same chain-resolver pattern as the other listing
    // queries so each row carries `approvalChain` for downstream UI.
    const tupleKey = (e: string, p: string | null) => `${e}::${p ?? ""}`
    const tuples = new Map<string, { employeeId: string; projectId: string | null }>()
    for (const r of rows) {
      const k = tupleKey(r.employeeId, r.projectId)
      if (!tuples.has(k)) {
        tuples.set(k, { employeeId: r.employeeId, projectId: r.projectId })
      }
    }
    const chainByTuple = new Map<string, GroupedChainStep[]>()
    if (tuples.size > 0) {
      const resolved = await Promise.all(
        Array.from(tuples.entries()).map(async ([k, t]) => ({
          k,
          steps: await resolveModuleChain(
            t.employeeId,
            "CLAIMS",
            t.projectId ?? undefined,
          ),
        })),
      )
      for (const { k, steps } of resolved) {
        chainByTuple.set(
          k,
          steps.map((s) => ({
            step: s.step,
            approvers: s.approvers.map((a) => ({
              approverId: a.approverId,
              name: a.name,
              email: a.email,
              role: a.role,
            })),
          })),
        )
      }
    }

    const mapped = rows.map((row) => {
      const key = tupleKey(row.employeeId, row.projectId)
      const single = new Map<string, GroupedChainStep[]>()
      single.set(row.employeeId, chainByTuple.get(key) ?? [])
      return mapClaim(row, single)
    })

    return {
      rows: mapped,
      total,
      totalAmount: toNumber(sumRow._sum.amount, 0),
    }
  },

  async getMemberClaimsForBreakdown(input: {
    organizationId: string
    projectId: string
    employeeId: string
    monthStart: Date
    monthEnd: Date
  }): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        employeeId: input.employeeId,
        spentAt: { gte: input.monthStart, lt: input.monthEnd },
      },
      include: claimInclude,
      orderBy: { spentAt: "desc" },
    })

    // Reuse the existing chain-resolver pattern so the row shape matches
    // ClaimRecord and the existing claims table can be reused if wanted.
    const chainByEmployee = new Map<string, GroupedChainStep[]>()
    if (rows.length > 0) {
      const steps = await resolveModuleChain(
        input.employeeId,
        "CLAIMS",
        input.projectId,
      )
      chainByEmployee.set(
        input.employeeId,
        steps.map((s) => ({
          step: s.step,
          approvers: s.approvers.map((a) => ({
            approverId: a.approverId,
            name: a.name,
            email: a.email,
            role: a.role,
          })),
        })),
      )
    }

    return rows.map((row) => mapClaim(row, chainByEmployee))
  },

  async getFirstAdminId(organizationId?: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: {
        role: { in: ["ADMIN", "OWNER"] },
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
          : role === "ADMIN"
            ? { email, role: { in: ["ADMIN", "OWNER"] } }
            : { email, role },
    })
    return row?.id ?? null
  },

  /// Returns the user IDs of every layer-1 approver across every team chain
  /// the employee participates in. Used by the claim-submission push notifier
  /// to alert the people who'll see the claim first.
  async getFirstStepApproverIdsForUser(userId: string): Promise<string[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.approvalChainStep.findMany({
      where: { employeeId: userId, step: 1 },
      select: { approverId: true },
    })

    return Array.from(new Set(rows.map((r) => r.approverId)))
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
        projectId: data.projectId ?? null,
        chartOfAccountId: data.chartOfAccountId,
        amount: data.amount,
        currency: data.currency,
        spentAt: data.spentAt,
        claimRunMonth: data.claimRunMonth,
        receiptUrl: data.receiptUrl,
        employeeId: data.employeeId,
        lastReviewerId: data.reviewerId,
        paymentType: data.paymentType,
        payViaAccountId: data.payViaAccountId ?? null,
        exceedsLimit: data.exceedsLimit ?? false,
        xeroFileId: data.xeroFileId ?? null,
        spendingWith: data.spendingWith ?? null,
        distance: data.distance,
        mileageOriginAddress: data.mileageOriginAddress,
        mileageDestinationAddress: data.mileageDestinationAddress,
        mileageRateUsed: data.mileageRateUsed,
        mileageUnitUsed: data.mileageUnitUsed,
        // Nested-create the supporting attachments in the same
        // transaction as the Claim. Prisma's create-with-related
        // mode means we don't need to find the claim ID first.
        ...(data.supportingAttachments &&
        data.supportingAttachments.length > 0
          ? {
              supportingAttachments: {
                create: data.supportingAttachments.map((att) => ({
                  fileName: att.fileName,
                  fileUrl: att.fileUrl ?? null,
                  xeroFileId: att.xeroFileId ?? null,
                  mimeType: att.mimeType ?? null,
                  sizeBytes: att.sizeBytes ?? null,
                })),
              },
            }
          : {}),
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
        lastReviewedAt: true,
        lastReviewerId: true,
        employeeId: true,
        projectId: true,
        paymentType: true,
        employee: {
          select: {
            email: true,
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
    // Realtime fan-out targets (supervisor branch only).
    let nextApproverIds: string[] = []
    let peerApproverIds: string[] = []

    if (data.supervisorOnly) {
      // Load the employee's *module-filtered, grouped* approval chain
      // (CLAIMS). Multi-approver semantics: the reviewer's step is the
      // step whose approvers SET contains them. The previous reviewer's
      // step is found the same way. When the last step's approvers set
      // is satisfied (any of them approves), claim moves to APPROVED.
      const chain = await resolveModuleChain(
        existingClaim.employeeId,
        "CLAIMS",
        existingClaim.projectId ?? undefined,
      )

      let supervisorChainComplete = true
      let actedStepNumber: number | null = null

      if (chain.length > 0) {
        const reviewerStep = chain.find((s) =>
          s.approvers.some((a) => a.approverId === data.reviewerId),
        )
        const reviewedStep =
          existingClaim.lastReviewerId !== null
            ? chain.find((s) =>
                s.approvers.some(
                  (a) => a.approverId === existingClaim.lastReviewerId,
                ),
              )
            : undefined

        let expectedStep = chain[0]!.step
        if (existingClaim.status === "PENDING" && existingClaim.lastReviewedAt !== null) {
          if (!reviewedStep) {
            return { ok: false, error: "NOT_FOUND" }
          }
          expectedStep = reviewedStep.step + 1
        }

        if (!reviewerStep || reviewerStep.step !== expectedStep) {
          return { ok: false, error: "NOT_FOUND" }
        }

        supervisorChainComplete = reviewerStep.step === chain[chain.length - 1]!.step
        actedStepNumber = reviewerStep.step

        // Realtime targets: peers at this step (so the claim leaves their
        // queue once handled) and, when approving advances the chain, the
        // next step's approvers (so it appears live in their queue).
        peerApproverIds = reviewerStep.approvers
          .map((a) => a.approverId)
          .filter((id) => id !== data.reviewerId)
        if (data.status === "APPROVED" && !supervisorChainComplete) {
          const idx = chain.findIndex((s) => s.step === reviewerStep.step)
          nextApproverIds =
            chain[idx + 1]?.approvers.map((a) => a.approverId) ?? []
        }
      } else {
        // Orphaned employee: no chain at all → reject. Every employee should
        // be in at least one team after the legacy-fallback removal; this
        // guards the rare case where a chain row has been wiped.
        return { ok: false, error: "NOT_FOUND" }
      }

      const nextStatus = decideNextClaimStatus({
        decision: data.status,
        reviewerKind: "SUPERVISOR",
        supervisorChainComplete,
      })
      persistedStatus = nextStatus
      const reviewedAt = new Date()

      await prisma.claim.update({
        where: { id: data.claimId },
        data: {
          status: nextStatus,
          reviewNotes: data.reviewNotes || null,
          lastReviewedAt: reviewedAt,
          lastReviewerId: data.reviewerId,
          // Snapshot the reviewer's role at decision time so the UI can
          // filter and label "approved/rejected by supervisor" later.
          reviewerRole: "SUPERVISOR",
        },
      })

      // Per-step audit entry. One row per supervisor decision so the
      // chain renderer can show *exactly* who acted at each step (vs.
      // who was eligible but didn't). Multi-approver-per-step still
      // produces a single entry — the actor; peers stay un-recorded.
      //
      // The `as` cast is a transient workaround: the sandbox can't run
      // `npx prisma generate`, so the generated client's PrismaClient
      // type doesn't know about `claimApprovalEntry` yet. Once the user
      // runs `npx prisma generate` locally the cast becomes a no-op.
      if (actedStepNumber !== null) {
        const prismaWithEntries = prisma as unknown as {
          claimApprovalEntry: {
            upsert: (args: unknown) => Promise<unknown>
          }
        }
        await prismaWithEntries.claimApprovalEntry.upsert({
          where: {
            claimId_stepNumber_approverId: {
              claimId: data.claimId,
              stepNumber: actedStepNumber,
              approverId: data.reviewerId,
            },
          },
          create: {
            claimId: data.claimId,
            stepNumber: actedStepNumber,
            approverId: data.reviewerId,
            decision: data.status === "APPROVED" ? "APPROVED" : "REJECTED",
            reviewedAt,
            reviewNotes: data.reviewNotes || null,
          },
          // Idempotent: if somehow the same approver is re-recorded for
          // the same step (e.g. retry), update the timestamp + decision.
          update: {
            decision: data.status === "APPROVED" ? "APPROVED" : "REJECTED",
            reviewedAt,
            reviewNotes: data.reviewNotes || null,
          },
        })
      }
    } else {
      // Admin review — always terminal. COA changes used to live here
      // but were moved to the sync stage (`syncClaim` below): the admin
      // recodes immediately before pushing to Xero, not at review time.
      // This keeps the chart-of-account chosen by the employee visible
      // through the approval chain and only changes if Xero needs it.
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
          lastReviewedAt: new Date(),
          lastReviewerId: data.reviewerId,
          reviewerRole: "ADMIN",
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
      nextApproverIds,
      peerApproverIds,
    }
  },

  /**
   * Mark a REVIEWED claim as synced to Xero. The admin can pass a final
   * `chartOfAccountId` override here — this is the ONLY place a COA can
   * be changed after the claim left the employee's hands. The optional
   * `xeroBillId` / `xeroBillRef` come from the Xero create-bill response;
   * the route currently stubs them out and lets the real Xero call get
   * wired in later (see syncClaimToXero in claim-workflow.service.ts).
   *
   * Pre-conditions:
   *   - claim exists
   *   - status === REVIEWED (admin has approved it)
   *   - xeroSyncStatus === NOT_SYNCED (idempotent: already-synced is a noop)
   */
  async syncClaim(data: {
    claimId: string
    chartOfAccountId?: string
    xeroBillId?: string | null
    xeroBillRef?: string | null
  }): Promise<
    | {
        ok: true
        employeeEmail: string
        employeeUserId: string
        claimTitle: string
      }
    | { ok: false; error: "DB_UNAVAILABLE" | "NOT_FOUND" | "NOT_ACTIONABLE" }
  > {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false, error: "DB_UNAVAILABLE" }

    const existing = await prisma.claim.findUnique({
      where: { id: data.claimId },
      select: {
        id: true,
        title: true,
        status: true,
        xeroSyncStatus: true,
        employeeId: true,
        employee: { select: { email: true } },
      },
    })
    if (!existing) return { ok: false, error: "NOT_FOUND" }
    if (existing.status !== "REVIEWED") {
      return { ok: false, error: "NOT_ACTIONABLE" }
    }
    if (existing.xeroSyncStatus === "SYNCED") {
      return { ok: false, error: "NOT_ACTIONABLE" }
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        xeroSyncStatus: "SYNCED",
        xeroSyncedAt: new Date(),
        xeroSyncError: null,
        ...(data.chartOfAccountId
          ? { chartOfAccountId: data.chartOfAccountId }
          : {}),
        ...(data.xeroBillId !== undefined ? { xeroBillId: data.xeroBillId } : {}),
        ...(data.xeroBillRef !== undefined
          ? { xeroBillRef: data.xeroBillRef }
          : {}),
      },
    })

    return {
      ok: true,
      employeeEmail: existing.employee.email,
      employeeUserId: existing.employeeId,
      claimTitle: existing.title,
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
        paymentType: true,
        xeroBillId: true,
        xeroSpendMoneyId: true,
        xeroFileId: true,
        organizationId: true,
        payViaAccountId: true,
        chartOfAccount: {
          select: {
            code: true,
            name: true,
            xeroAccountId: true,
          },
        },
        project: {
          select: { name: true },
        },
        employee: {
          select: {
            name: true,
            email: true,
          },
        },
        supportingAttachments: {
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            fileUrl: true,
            xeroFileId: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    })

    if (!claim) return null

    // For COMPANY claims, resolve the picked bank account's Xero code —
    // it's the "paid from" account on the Spend Money transaction.
    const payViaBankAccount = claim.payViaAccountId
      ? await prisma.chartOfAccount.findUnique({
          where: { id: claim.payViaAccountId },
          select: { code: true, name: true },
        })
      : null

    // The bill posts to the org's single Xero connection — resolve it
    // from the org rather than a per-account column.
    const connection = claim.organizationId
      ? await prisma.xeroConnection.findFirst({
          where: { organizationId: claim.organizationId },
          select: { id: true },
        })
      : null

    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      title: claim.title,
      description: claim.description,
      amount: Number(claim.amount),
      currency: claim.currency,
      spentAt: claim.spentAt,
      paymentType: claim.paymentType as PaymentType,
      xeroBillId: claim.xeroBillId,
      xeroSpendMoneyId: claim.xeroSpendMoneyId,
      payViaBankAccount: payViaBankAccount
        ? {
            code: payViaBankAccount.code,
            name: payViaBankAccount.name,
            xeroConnectionId: connection?.id ?? null,
          }
        : null,
      xeroFileId: claim.xeroFileId,
      organizationId: claim.organizationId,
      chartOfAccount: claim.chartOfAccount
        ? { ...claim.chartOfAccount, xeroConnectionId: connection?.id ?? null }
        : null,
      project: claim.project,
      employee: claim.employee,
      supportingAttachments: claim.supportingAttachments.map((att) => ({
        id: att.id,
        fileName: att.fileName,
        mimeType: att.mimeType,
        fileUrl: att.fileUrl,
        xeroFileId: att.xeroFileId,
      })),
    }
  },

  async markSupportingAttachmentXeroFile(data: {
    attachmentId: string
    xeroFileId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    await prisma.claimSupportingAttachment.update({
      where: { id: data.attachmentId },
      data: { xeroFileId: data.xeroFileId },
    })
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

  /**
   * Map claim IDs → their expense account's Xero code. Used by the
   * payroll manual-journal builder to debit the right expense account
   * for each reimbursement line. Claims whose expense account has no
   * Xero code (custom/non-Xero account) are omitted from the map — the
   * caller treats a missing entry as "can't journal this one".
   */
  async getExpenseAccountCodesForClaims(
    claimIds: string[],
  ): Promise<Map<string, string>> {
    if (claimIds.length === 0) return new Map()
    const prisma = getPrismaClient()
    if (!prisma) return new Map()
    const rows = await prisma.claim.findMany({
      where: { id: { in: claimIds } },
      select: { id: true, chartOfAccount: { select: { code: true } } },
    })
    const map = new Map<string, string>()
    for (const row of rows) {
      if (row.chartOfAccount?.code) map.set(row.id, row.chartOfAccount.code)
    }
    return map
  },

  /**
   * Claim metadata needed by payroll's Manual Journal builder for
   * reimbursements attached to a payroll run. The debit goes to the
   * claim's selected expense account, and tracking follows the claim
   * project selected at submission time.
   */
  async getReimbursementJournalDataForClaims(
    claimIds: string[],
  ): Promise<
    Map<
      string,
      {
        accountCode: string | null
        accountName: string | null
        projectName: string | null
      }
    >
  > {
    if (claimIds.length === 0) return new Map()
    const prisma = getPrismaClient()
    if (!prisma) return new Map()
    const rows = await prisma.claim.findMany({
      where: { id: { in: claimIds } },
      select: {
        id: true,
        chartOfAccount: { select: { code: true, name: true } },
        project: { select: { name: true } },
      },
    })
    const map = new Map<
      string,
      {
        accountCode: string | null
        accountName: string | null
        projectName: string | null
      }
    >()
    for (const row of rows) {
      map.set(row.id, {
        accountCode: row.chartOfAccount?.code ?? null,
        accountName: row.chartOfAccount?.name ?? null,
        projectName: row.project?.name ?? null,
      })
    }
    return map
  },

  async markClaimSpendMoneySynced(data: {
    claimId: string
    xeroSpendMoneyId: string
    xeroSpendMoneyRef?: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        xeroSpendMoneyId: data.xeroSpendMoneyId,
        xeroSpendMoneyRef: data.xeroSpendMoneyRef ?? null,
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
