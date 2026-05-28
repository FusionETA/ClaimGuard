import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { randomBytes } from "node:crypto"

import { z } from "zod"

import type { AuthenticatedSession } from "@/lib/auth/types"
import { isKnownCurrency, SYSTEM_FALLBACK_CURRENCY } from "@/lib/currencies"
import { computeMileageAmount, resolveMileageRate } from "@/lib/mileage"
import { notify } from "@/modules/notifications/application/services/notification.service"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { publishUserEvents } from "@/lib/realtime"
import {
  storeReceiptForClaim,
  storeSupportingFileForClaim,
} from "@/modules/claims/application/services/claim-receipts.service"
import { claimMatchesStatusFilter } from "@/modules/claims/domain/models"
import type {
  ClaimRecord,
  ClaimStatus,
  ClaimRunPreview,
} from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import type {
  ChartOfAccountOption,
  LimitPeriod,
} from "@/modules/organization/domain/models"

// Re-export so existing callers (`import { computeMileageAmount } from
// ".../claim-workflow.service"`) keep working without changes.
export { computeMileageAmount, resolveMileageRate }

/**
 * Common claim fields shared by the EXPENSE and MILEAGE branches.
 * - paymentType (PERSONAL vs COMPANY) is a label only for workflow state, but
 *   COMPANY-money claims must record which selected bank account paid.
 * - Mileage claims still record an "amount" but it's computed server-side
 *   from distance × rate.
 */
const baseClaimSchema = z.object({
  title: z.string().min(3, "Give the claim a short title."),
  chartOfAccountId: z.string().min(1, "Select the chart of account for this claim."),
  spentAt: z.string().min(1, "Select the expense date."),
  description: z.string(),
  receiptUrl: z.string().optional(),
  paymentType: z.enum(["PERSONAL", "COMPANY"]).default("PERSONAL"),
  payViaAccountId: z.string().optional(),
  /// Project this claim is filed against. Required when the employee has
  /// any project assignments — drives module-aware approval routing.
  projectId: z.string().optional(),
  /// ISO 4217 currency code chosen on the form. Validated server-side
  /// against the org's allowedCurrencies list before insert. Optional in
  /// the schema so older form callers that don't ship it still work; the
  /// service falls back to org.defaultCurrency, then to MYR.
  currency: z.string().trim().toUpperCase().optional(),
  /// Optional free-text "who you spent the money with" (client, vendor,
  /// internal team). Trimmed; empty string is treated as null. Capped
  /// at 200 chars so admins reviewing don't see runaway text.
  spendingWith: z.string().trim().max(200).optional(),
})

const expenseClaimSchema = baseClaimSchema.extend({
  claimType: z.literal("EXPENSE"),
  amount: z.coerce.number().positive("Amount must be greater than zero."),
})

const mileageClaimSchema = baseClaimSchema.extend({
  claimType: z.literal("MILEAGE"),
  distance: z.coerce.number().positive("Distance must be greater than zero."),
  mileageOriginAddress: z.string().min(1, "Enter the trip origin."),
  mileageDestinationAddress: z.string().min(1, "Enter the trip destination."),
})

const createClaimBaseSchema = z.discriminatedUnion("claimType", [
  expenseClaimSchema,
  mileageClaimSchema,
])

export const createClaimSchema = createClaimBaseSchema.superRefine((data, ctx) => {
  if (data.paymentType === "COMPANY" && !data.payViaAccountId?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payViaAccountId"],
      message: "Select the company bank account that paid for this claim.",
    })
  }
})

export const reviewClaimSchema = z
  .object({
    claimId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z
      .string()
      .max(1000, "Keep the review note under 1000 characters.")
      .transform((value) => value.trim()),
  })
  .superRefine((data, ctx) => {
    if (data.decision === "REJECTED" && data.reason.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Please give a short reason before rejecting this claim.",
      })
    }
  })

export type ReviewClaimInput = {
  claimId: string
  decision: string
  reason: string
}

/**
 * Admin's final review takes the same shape as a supervisor review now.
 * COA changes used to live here; they were moved to the post-approval
 * sync stage (see `syncClaimToXero`) so the chart-of-account chosen by
 * the employee is preserved through the approval chain. The admin only
 * recodes immediately before pushing to Xero.
 */
export type AdminReviewClaimInput = ReviewClaimInput

export type CreateClaimInput = {
  title: string
  chartOfAccountId: string
  amount?: string | number
  spentAt: string
  description: string
  /// Pre-uploaded receipt URL. Kept for backwards-compat with callers
  /// that still pass a URL. New employee-portal callers pass
  /// `receiptFile` instead and the workflow handles upload.
  receiptUrl?: string
  /// Receipt file to upload. The service decides where it goes (Xero
  /// Files vs local disk) based on the chart-of-account's Xero
  /// connection. Empty / undefined means "no receipt for this claim".
  receiptFile?: File
  /// Optional supporting documents beyond the primary OCR'd receipt.
  /// Each file is uploaded to the same destination as the primary
  /// receipt (Xero Files when the COA is Xero-linked, local disk
  /// otherwise). Maximum 10 files per claim, 8 MB each. Empty array
  /// or undefined means "no extras".
  supportingFiles?: File[]
  paymentType?: "PERSONAL" | "COMPANY"
  payViaAccountId?: string
  /// Project the claim is filed against. Required when the employee has
  /// project assignments; null/undefined OK only when they don't.
  projectId?: string
  /// Optional free-text "who you spent with" (client / vendor name).
  /// Passed through to the DB; not validated against any list.
  spendingWith?: string
  // Mileage-claim fields. Required when claimType === "MILEAGE", ignored otherwise.
  claimType?: "EXPENSE" | "MILEAGE"
  distance?: string | number
  mileageOriginAddress?: string
  mileageDestinationAddress?: string
}

export type CreateClaimFieldErrors = {
  title?: string
  chartOfAccountId?: string
  amount?: string
  spentAt?: string
  description?: string
  receiptUrl?: string
  paymentType?: string
  payViaAccountId?: string
  projectId?: string
  claimType?: string
  distance?: string
  mileageOriginAddress?: string
  mileageDestinationAddress?: string
}

export type CreateClaimServiceResult =
  | {
      ok: true
      /// Set when the claim was saved but flagged because it exceeds the
      /// account spend limit. The claim itself goes through the normal
      /// approval flow; this just lets the form surface the warning.
      warning?: string
    }
  | {
      ok: false
      status: number
      message: string
      values: CreateClaimInput
      fieldErrors?: CreateClaimFieldErrors
    }

export type ReviewClaimServiceResult =
  | {
      ok: true
      claimStatus: ClaimStatus
      reviewerName: string
      reason: string
    }
  | {
      ok: false
      status: number
      message: string
      reason?: string
      fieldErrors?: {
        reason?: string
      }
    }

export async function listClaimsForSession({
  session,
  status,
}: {
  session: AuthenticatedSession
  status?: ClaimStatus | "ALL"
}): Promise<ClaimRecord[]> {
  const claims =
    isAdminRole(session.role)
      ? session.organizationId
        ? await claimRepository.getClaimsForOrganization(session.organizationId)
        : []
      : await claimRepository.getClaimsByEmployee(session.email)

  return claims.filter((claim) => claimMatchesStatusFilter(claim, status))
}

export async function listClaimsForSupervisorReview({
  session,
  status,
}: {
  session: AuthenticatedSession
  status?: ClaimStatus | "ALL"
}): Promise<ClaimRecord[]> {
  if (session.role !== "SUPERVISOR") {
    return []
  }

  const claims = await claimRepository.getClaimsForSupervisor(session.email)
  return claims.filter((claim) => claimMatchesStatusFilter(claim, status))
}

export async function countPendingClaimsForSupervisor(
  supervisorEmail: string
): Promise<number> {
  // Count-only repo method — no claim hydration, no chain join.
  return claimRepository.countPendingForSupervisor(supervisorEmail)
}

/**
 * Pure helpers for limits + mileage. Exported so tests can call them directly
 * and the employee form can preview "X of Y used" without needing the full
 * service pipeline.
 */

/**
 * Returns the [start, end) window that a limitPeriod covers, anchored on the
 * spend date. PER_CLAIM uses an empty window — the limit is checked against
 * the single claim amount, not historical totals.
 */
export function getPeriodWindow(
  period: LimitPeriod,
  refDate: Date
): { start: Date; end: Date } {
  if (period === "PER_CLAIM") {
    return { start: refDate, end: refDate }
  }
  if (period === "MONTHLY") {
    const start = new Date(refDate.getFullYear(), refDate.getMonth(), 1)
    const end = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 1)
    return { start, end }
  }
  // YEARLY (calendar year)
  const start = new Date(refDate.getFullYear(), 0, 1)
  const end = new Date(refDate.getFullYear() + 1, 0, 1)
  return { start, end }
}

export type LimitCheckResult =
  | { ok: true }
  | {
      ok: false
      limit: number
      used: number
      remaining: number
      attempted: number
      period: LimitPeriod
    }

/**
 * Validates that adding a new claim of `amount` to the given chart of account
 * won't exceed its configured spend limit. Always returns ok:true if the
 * account has no limit configured.
 */
export async function checkClaimAccountLimit(input: {
  organizationId: string
  account: ChartOfAccountOption
  employeeId: string
  amount: number
  spentAt: Date
  excludeClaimId?: string
}): Promise<LimitCheckResult> {
  const { account, amount } = input
  if (
    account.limitAmount == null ||
    account.limitPeriod == null ||
    account.limitScope == null
  ) {
    return { ok: true }
  }

  const period = account.limitPeriod
  const limit = account.limitAmount

  // PER_CLAIM is just an upper bound on a single submission.
  if (period === "PER_CLAIM") {
    if (amount > limit) {
      return {
        ok: false,
        limit,
        used: 0,
        remaining: limit,
        attempted: amount,
        period,
      }
    }
    return { ok: true }
  }

  const { start, end } = getPeriodWindow(period, input.spentAt)

  const used = await claimRepository.sumClaimsForLimit({
    organizationId: input.organizationId,
    chartOfAccountId: account.id,
    employeeId:
      account.limitScope === "PER_EMPLOYEE" ? input.employeeId : undefined,
    periodStart: start,
    periodEnd: end,
    excludeClaimId: input.excludeClaimId,
  })

  const remaining = Math.max(0, limit - used)
  if (used + amount > limit) {
    return {
      ok: false,
      limit,
      used,
      remaining,
      attempted: amount,
      period,
    }
  }
  return { ok: true }
}

export type RemainingLimitInfo = {
  limit: number
  used: number
  remaining: number
  period: LimitPeriod
  scope: "PER_EMPLOYEE" | "ORG_WIDE"
}

/**
 * Computes "X of Y remaining" for a given account, used by the employee form
 * to show a hint before submission. Returns null when the account has no limit.
 */
export async function getRemainingLimit(input: {
  organizationId: string
  account: ChartOfAccountOption
  employeeId: string
  refDate?: Date
}): Promise<RemainingLimitInfo | null> {
  const { account } = input
  if (
    account.limitAmount == null ||
    account.limitPeriod == null ||
    account.limitScope == null
  ) {
    return null
  }

  const period = account.limitPeriod
  // PER_CLAIM has no historical sum — always full limit available.
  if (period === "PER_CLAIM") {
    return {
      limit: account.limitAmount,
      used: 0,
      remaining: account.limitAmount,
      period,
      scope: account.limitScope,
    }
  }

  const refDate = input.refDate ?? new Date()
  const { start, end } = getPeriodWindow(period, refDate)
  const used = await claimRepository.sumClaimsForLimit({
    organizationId: input.organizationId,
    chartOfAccountId: account.id,
    employeeId:
      account.limitScope === "PER_EMPLOYEE" ? input.employeeId : undefined,
    periodStart: start,
    periodEnd: end,
  })

  return {
    limit: account.limitAmount,
    used,
    remaining: Math.max(0, account.limitAmount - used),
    period,
    scope: account.limitScope,
  }
}

export async function createClaimForEmployee({
  session,
  input,
}: {
  session: AuthenticatedSession
  input: CreateClaimInput
}): Promise<CreateClaimServiceResult> {
  if (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR") {
    return {
      ok: false,
      status: 403,
      message: "Only employees and supervisors can submit claims.",
      values: input,
    }
  }

  // Default older callers (which don't yet send claimType) to EXPENSE so this
  // change is backwards-compatible during the transition.
  const normalised = {
    ...input,
    claimType: input.claimType ?? "EXPENSE",
  }

  const parsed = createClaimSchema.safeParse(normalised)

  if (!parsed.success) {
    // Zod's discriminated-union flatten() narrows to the common keys, so cast
    // to a generic record to access branch-specific fields.
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<
      string,
      string[] | undefined
    >

    return {
      ok: false,
      status: 400,
      message: "Please review the highlighted fields and try again.",
      values: input,
      fieldErrors: {
        title: fieldErrors.title?.[0],
        chartOfAccountId: fieldErrors.chartOfAccountId?.[0],
        amount: fieldErrors.amount?.[0],
        spentAt: fieldErrors.spentAt?.[0],
        description: fieldErrors.description?.[0],
        receiptUrl: fieldErrors.receiptUrl?.[0],
        paymentType: fieldErrors.paymentType?.[0],
        payViaAccountId: fieldErrors.payViaAccountId?.[0],
        claimType: fieldErrors.claimType?.[0],
        distance: fieldErrors.distance?.[0],
        mileageOriginAddress: fieldErrors.mileageOriginAddress?.[0],
        mileageDestinationAddress: fieldErrors.mileageDestinationAddress?.[0],
      },
    }
  }

  const [employeeId, reviewerId] = await Promise.all([
    claimRepository.getUserId(session.email, "EMPLOYEE"),
    claimRepository.getFirstAdminId(session.organizationId),
  ])

  if (!employeeId) {
    return {
      ok: false,
      status: 404,
      message: "Employee account not found. Contact your administrator.",
      values: input,
    }
  }

  if (!session.organizationId) {
    return {
      ok: false,
      status: 409,
      message: "Your account is not assigned to an organization yet.",
      values: input,
    }
  }

  const [organization, chartOfAccount] = await Promise.all([
    organizationRepository.getOrganizationById(session.organizationId),
    organizationRepository.getChartAccountByIdForOrganization({
      organizationId: session.organizationId,
      chartOfAccountId: parsed.data.chartOfAccountId,
      forClaimType: parsed.data.claimType,
    }),
  ])

  if (!organization) {
    return {
      ok: false,
      status: 404,
      message: "Your organization settings could not be found.",
      values: input,
    }
  }

  if (!chartOfAccount) {
    const message =
      parsed.data.claimType === "MILEAGE"
        ? "Select an account configured for mileage claims."
        : "Select an enabled chart of account option."
    return {
      ok: false,
      status: 400,
      message: "Please choose one of the enabled chart of account options.",
      values: input,
      fieldErrors: {
        chartOfAccountId: message,
      },
    }
  }

  let payViaAccountId: string | undefined
  if (parsed.data.paymentType === "COMPANY") {
    const bankAccount = await organizationRepository.getSelectedBankAccountByIdForOrganization({
      organizationId: session.organizationId,
      chartAccountId: parsed.data.payViaAccountId ?? "",
    })

    if (!bankAccount) {
      return {
        ok: false,
        status: 400,
        message: "Please choose one of the enabled company bank accounts.",
        values: input,
        fieldErrors: {
          payViaAccountId:
            "Select a bank account enabled by your admin for company-money claims.",
        },
      }
    }

    payViaAccountId = bankAccount.id
  }

  // Resolve final amount + mileage snapshot fields based on claim type.
  let finalAmount: number
  let distanceForDb: string | undefined
  let mileageOriginAddress: string | undefined
  let mileageDestinationAddress: string | undefined
  let mileageRateUsed: string | undefined
  let mileageUnitUsed: "KM" | "MILE" | undefined

  if (parsed.data.claimType === "MILEAGE") {
    const resolved = resolveMileageRate({ organization, account: chartOfAccount })
    if (!resolved) {
      return {
        ok: false,
        status: 400,
        message:
          "Mileage rate is not configured. Ask your admin to set the rate in Mileage claim settings.",
        values: input,
        fieldErrors: {
          chartOfAccountId: "No mileage rate configured for this account.",
        },
      }
    }

    finalAmount = computeMileageAmount({
      distance: parsed.data.distance,
      rate: resolved.rate,
    })

    if (finalAmount <= 0) {
      return {
        ok: false,
        status: 400,
        message: "Mileage amount must be greater than zero.",
        values: input,
        fieldErrors: { distance: "Distance must be greater than zero." },
      }
    }

    distanceForDb = parsed.data.distance.toFixed(2)
    mileageOriginAddress = parsed.data.mileageOriginAddress
    mileageDestinationAddress = parsed.data.mileageDestinationAddress
    mileageRateUsed = resolved.rate.toFixed(4)
    mileageUnitUsed = resolved.unit
  } else {
    finalAmount = parsed.data.amount
  }

  // Spend-limit check — applies to both expense and mileage claims.
  // Submission is no longer rejected on limit exceed; instead the claim
  // is saved with `exceedsLimit = true` so admins can spot it. The form
  // shows a non-blocking warning before the user submits (driven by the
  // remaining-limit hint), and the submission result includes a warning
  // message when the flag was set.
  const limitCheck = await checkClaimAccountLimit({
    organizationId: session.organizationId,
    account: chartOfAccount,
    employeeId,
    amount: finalAmount,
    spentAt: new Date(parsed.data.spentAt),
  })
  const exceedsLimit = !limitCheck.ok
  const exceedsLimitMessage = exceedsLimit
    ? (() => {
        const periodLabel =
          limitCheck.period === "PER_CLAIM"
            ? "per claim"
            : limitCheck.period === "MONTHLY"
              ? "this month"
              : "this year"
        return `Submitted, but flagged: this claim exceeds the ${chartOfAccount.name} limit (${periodLabel}). Limit: ${limitCheck.limit.toFixed(2)}, used: ${limitCheck.used.toFixed(2)}, attempted: ${limitCheck.attempted.toFixed(2)}.`
      })()
    : undefined

  const claimRunMonth = calculateClaimRunMonth({
    submittedAt: new Date(),
    claimCutoffDay: organization.claimCutoffDay,
  })

  // Validate the chosen projectId belongs to the employee. If the
  // employee has project assignments, projectId is required.
  const employeeProjects =
    await organizationRepository.getProjectsForEmployee(employeeId)
  if (employeeProjects.length > 0) {
    const assignedProjectIds = new Set(employeeProjects.map((p) => p.id))
    if (!parsed.data.projectId || !assignedProjectIds.has(parsed.data.projectId)) {
      return {
        ok: false,
        status: 400,
        message: "Pick a project from your assigned projects.",
        values: input,
        fieldErrors: {
          projectId: "Select one of your assigned projects.",
        },
      }
    }
  }

  // Store the receipt — to Xero Files when the COA is Xero-connected,
  // local disk otherwise. Pre-uploaded receiptUrl from older callers
  // still wins if they passed one. New employee-portal submissions go
  // through this path with a File object. (receiptFile reads off the
  // raw input rather than parsed.data because the Zod schema doesn't
  // model File — passing it through would double the schema's complexity
  // for no validation benefit.)
  // Receipt files upload to the org's single Xero Files area when the
  // org is Xero-connected (resolved from the org, not a per-account
  // column), else they store locally.
  const orgXeroConnectionId =
    await organizationRepository.getActiveXeroConnectionId(
      session.organizationId,
    )
  let storedReceiptUrl = parsed.data.receiptUrl?.trim() || undefined
  let storedXeroFileId: string | null = null
  let receiptStorageWarning: string | undefined
  const receiptFile =
    input.receiptFile instanceof File ? input.receiptFile : undefined
  if (!storedReceiptUrl && receiptFile) {
    try {
      const stored = await storeReceiptForClaim({
        receiptFile,
        xeroConnectionId: orgXeroConnectionId,
      })
      storedReceiptUrl = stored.receiptUrl
      storedXeroFileId = stored.xeroFileId
      if (stored.warning) receiptStorageWarning = stored.warning
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Receipt upload failed."
      return {
        ok: false,
        status: 400,
        message,
        values: input,
        fieldErrors: { receiptUrl: message },
      }
    }
  }

  // Supporting documents — uploaded the same way as the primary
  // receipt (Xero Files when possible, local disk otherwise), with a
  // wider MIME allowlist (PDFs, Office docs, etc.). A single file's
  // failure doesn't abort the submission — the claim still goes
  // through with whatever succeeded. The first error message is
  // surfaced in the action's warning toast.
  const supportingAttachments: Array<{
    fileName: string
    fileUrl: string | null
    xeroFileId: string | null
    mimeType: string
    sizeBytes: number
  }> = []
  let supportingStorageWarning: string | undefined
  const candidateSupporting = Array.isArray(input.supportingFiles)
    ? input.supportingFiles
        .filter((f): f is File => f instanceof File && f.size > 0)
        .slice(0, 10) // hard cap at 10 — prevents the form from sending hundreds
    : []
  for (const file of candidateSupporting) {
    try {
      const stored = await storeSupportingFileForClaim({
        file,
        xeroConnectionId: orgXeroConnectionId,
      })
      supportingAttachments.push({
        fileName: stored.fileName,
        fileUrl: stored.fileUrl,
        xeroFileId: stored.xeroFileId,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
      })
      if (stored.warning && !supportingStorageWarning) {
        supportingStorageWarning = stored.warning
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Supporting file ${file.name} failed to upload.`
      // Capture the first error as a warning but keep going.
      if (!supportingStorageWarning) supportingStorageWarning = message
    }
  }

  // Resolve the currency for this claim with this precedence:
  //   1. Form-supplied value, if it's a known ISO code AND the org has
  //      it in its allowedCurrencies list (or hasn't set a list yet).
  //   2. Org's defaultCurrency.
  //   3. System fallback (MYR).
  // The form layer enforces the list visually, but we re-validate
  // server-side so a tampered request can't slip through.
  const orgAllowed = organization.allowedCurrencies
  const submittedCurrency = parsed.data.currency
  let resolvedCurrency: string
  if (
    submittedCurrency &&
    isKnownCurrency(submittedCurrency) &&
    (orgAllowed.length === 0 || orgAllowed.includes(submittedCurrency))
  ) {
    resolvedCurrency = submittedCurrency
  } else if (organization.defaultCurrency) {
    resolvedCurrency = organization.defaultCurrency
  } else {
    resolvedCurrency = SYSTEM_FALLBACK_CURRENCY
  }

  const ok = await claimRepository.createClaim({
    // Full ms timestamp + 4 hex chars (16 bits of randomness) so two
    // concurrent submissions can't collide on the @unique claimNumber.
    // The previous `slice(-5)` of the timestamp wrapped every 100s and
    // collided in the same millisecond — surfaced to users as a
    // confusing 503 from the unique-constraint violation.
    claimNumber: `CLM-${Date.now()}-${randomBytes(2).toString("hex")}`,
    title: parsed.data.title,
    description: parsed.data.description,
    organizationId: session.organizationId,
    projectId: parsed.data.projectId ?? null,
    chartOfAccountId: parsed.data.chartOfAccountId,
    amount: finalAmount.toFixed(2),
    currency: resolvedCurrency,
    spentAt: new Date(parsed.data.spentAt),
    claimRunMonth: claimRunMonth.targetMonth,
    receiptUrl: storedReceiptUrl,
    xeroFileId: storedXeroFileId,
    employeeId,
    reviewerId,
    paymentType: parsed.data.paymentType,
    payViaAccountId,
    exceedsLimit,
    claimType: parsed.data.claimType,
    distance: distanceForDb,
    mileageOriginAddress,
    mileageDestinationAddress,
    mileageRateUsed,
    mileageUnitUsed,
    spendingWith: parsed.data.spendingWith?.trim() || null,
    supportingAttachments:
      supportingAttachments.length > 0 ? supportingAttachments : undefined,
  })

  if (!ok) {
    return {
      ok: false,
      status: 503,
      message: "Database is not configured. Contact your administrator.",
      values: input,
    }
  }

  try {
    const firstStepApproverIds = await claimRepository.getFirstStepApproverIdsForUser(employeeId)

    await Promise.all(
      firstStepApproverIds.map((approverId) =>
        notify({
          userId: approverId,
          organizationId: session.organizationId ?? null,
          type: "CLAIM_SUBMITTED",
          title: "New Claim Submitted",
          body: `${session.name} submitted "${parsed.data.title}" for review.`,
          url: "/employee/review",
        }),
      ),
    )
  } catch {
    // Push notifications should never block a successful claim submission.
  }

  // Combine the possible warnings (over-limit, receipt-fallback,
  // supporting-doc fallback) into one user-facing message. All are
  // non-fatal; the claim is saved either way.
  const combinedWarning = [
    exceedsLimitMessage,
    receiptStorageWarning,
    supportingStorageWarning,
  ]
    .filter(Boolean)
    .join(" ")
    .trim()
  return {
    ok: true,
    warning: combinedWarning ? combinedWarning : undefined,
  }
}

export function calculateClaimRunMonth({
  submittedAt,
  claimCutoffDay,
}: {
  submittedAt: Date
  claimCutoffDay: number
}): { targetMonth: Date } {
  const effectiveCutoff = Math.min(Math.max(claimCutoffDay, 1), 28)
  const target = new Date(submittedAt)

  if (submittedAt.getDate() > effectiveCutoff) {
    target.setMonth(target.getMonth() + 1)
  }

  target.setDate(1)
  target.setHours(0, 0, 0, 0)

  return { targetMonth: target }
}

export function buildClaimRunPreview({
  submittedAt,
  claimCutoffDay,
}: {
  submittedAt: Date
  claimCutoffDay: number
}): ClaimRunPreview {
  const { targetMonth } = calculateClaimRunMonth({
    submittedAt,
    claimCutoffDay,
  })

  const targetLabel = new Intl.DateTimeFormat("en-MY", {
    month: "long",
    year: "numeric",
  }).format(targetMonth)

  return {
    claimCutoffDay,
    submittedOn: submittedAt.toISOString(),
    targetMonth: targetMonth.toISOString(),
    targetLabel,
    isCurrentMonth:
      targetMonth.getMonth() === submittedAt.getMonth() &&
      targetMonth.getFullYear() === submittedAt.getFullYear(),
  }
}

export async function reviewClaimForSupervisor({
  session,
  input,
}: {
  session: AuthenticatedSession
  input: ReviewClaimInput
}): Promise<ReviewClaimServiceResult> {
  if (session.role !== "SUPERVISOR") {
    return {
      ok: false,
      status: 403,
      message: "Only supervisors can review claims.",
    }
  }

  const parsed = reviewClaimSchema.safeParse(input)

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors

    return {
      ok: false,
      status: 400,
      message: "Please fix the review note and try again.",
      reason: input.reason,
      fieldErrors: {
        reason: fieldErrors.reason?.[0],
      },
    }
  }

  const result = await claimRepository.reviewClaim({
    claimId: parsed.data.claimId,
    status: parsed.data.decision,
    reviewNotes: parsed.data.reason || undefined,
    reviewerId: session.userId,
    supervisorOnly: true,
  })

  if (!result.ok) {
    const messageMap = {
      DB_UNAVAILABLE: "Database is not configured. Contact your administrator.",
      NOT_FOUND: "This claim could not be found anymore.",
      NOT_ACTIONABLE: "This claim has already been reviewed.",
    } as const

    const statusMap = {
      DB_UNAVAILABLE: 503,
      NOT_FOUND: 404,
      NOT_ACTIONABLE: 409,
    } as const

    return {
      ok: false,
      status: statusMap[result.error],
      message: messageMap[result.error],
      reason: parsed.data.reason,
    }
  }

  // Supervisor / mid-chain reviews do NOT notify the employee — only the
  // admin's final review does (see reviewClaimForAdmin). This keeps the
  // employee from getting a "Claim Updated" ping at every chain step;
  // they hear once, when the decision is final.
  //
  // BUT we do fan out for the multi-supervisor live experience:
  //   - the NEXT step's approvers get a real notification (claim now in
  //     their queue + bell), and
  //   - peers at the step just acted on get a silent realtime nudge so
  //     the claim leaves their queue once a colleague has handled it.
  try {
    await Promise.all(
      (result.nextApproverIds ?? []).map((approverId) =>
        notify({
          userId: approverId,
          organizationId: session.organizationId ?? null,
          type: "CLAIM_SUBMITTED",
          title: "Claim Awaiting Your Approval",
          body: `A claim ("${result.claimTitle}") advanced to you for review.`,
          url: "/employee/review",
        }),
      ),
    )
    await publishUserEvents(result.peerApproverIds ?? [], {
      type: "claim",
      scope: "review",
    })

    // Tell the employee when a supervisor REJECTS — rejection is
    // terminal and never reaches the admin step, so without this the
    // employee would never hear the outcome. (Final approval still goes
    // to the admin, who notifies on the final decision.)
    if (result.claimStatus === "REJECTED") {
      await notify({
        userId: result.employeeUserId,
        organizationId: session.organizationId ?? null,
        type: "CLAIM_REVIEWED",
        title: "Claim Updated",
        body: `Your claim "${result.claimTitle}" was rejected.`,
        url: "/employee/claims",
      })
    }
  } catch {
    // Realtime / notifications must never block a successful review.
  }

  // Audit: supervisor / mid-chain claim review. Activity-feed wants
  // both APPROVE (chain advanced) and REJECT (terminal). The admin's
  // final review is audited separately in reviewClaimForAdmin.
  if (session.organizationId) {
    void writeAudit({
      organizationId: session.organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action:
        parsed.data.decision === "APPROVED"
          ? "claim.approve"
          : "claim.reject",
      status: "SUCCESS",
      summary:
        parsed.data.decision === "APPROVED"
          ? `Approved claim "${result.claimTitle}" (supervisor step)`
          : `Rejected claim "${result.claimTitle}" (supervisor step)`,
      targetType: "claim",
      targetId: parsed.data.claimId,
      metadata: parsed.data.reason ? { reason: parsed.data.reason } : null,
    })
  }

  return {
    ok: true,
    claimStatus: result.claimStatus,
    reviewerName: session.name,
    reason: parsed.data.reason,
  }
}

/**
 * Admin's final review / rejection on a claim that has cleared (or
 * skipped) the supervisor chain. Same shape as the supervisor flow plus an
 * optional `chartOfAccountId` override that the admin can pick from a
 * dropdown when recoding the claim before approving.
 */
export async function reviewClaimForAdmin({
  session,
  input,
}: {
  session: AuthenticatedSession
  input: AdminReviewClaimInput
}): Promise<ReviewClaimServiceResult> {
  if (!isAdminRole(session.role)) {
    return {
      ok: false,
      status: 403,
      message: "Only admins can give final review.",
    }
  }

  const parsed = reviewClaimSchema.safeParse(input)

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors

    return {
      ok: false,
      status: 400,
      message: "Please fix the review note and try again.",
      reason: input.reason,
      fieldErrors: {
        reason: fieldErrors.reason?.[0],
      },
    }
  }

  // COA changes are NOT allowed at the review stage anymore — they happen
  // immediately before Xero sync (see `syncClaimToXero` below). The admin
  // can only approve / reject here, with a review note.
  const result = await claimRepository.reviewClaim({
    claimId: parsed.data.claimId,
    status: parsed.data.decision,
    reviewNotes: parsed.data.reason || undefined,
    reviewerId: session.userId,
    supervisorOnly: false,
  })

  if (!result.ok) {
    const messageMap = {
      DB_UNAVAILABLE: "Database is not configured. Contact your administrator.",
      NOT_FOUND: "This claim could not be found anymore.",
      NOT_ACTIONABLE: "This claim has already been reviewed.",
    } as const

    const statusMap = {
      DB_UNAVAILABLE: 503,
      NOT_FOUND: 404,
      NOT_ACTIONABLE: 409,
    } as const

    return {
      ok: false,
      status: statusMap[result.error],
      message: messageMap[result.error],
      reason: parsed.data.reason,
    }
  }

  try {
    await notify({
      userId: result.employeeUserId,
      organizationId: session.organizationId ?? null,
      type: "CLAIM_REVIEWED",
      title: "Claim Updated",
      body:
        parsed.data.decision === "APPROVED"
          ? `Your claim "${result.claimTitle}" was approved.`
          : `Your claim "${result.claimTitle}" was rejected.`,
      url: "/employee/claims",
    })
  } catch {
    // Push notifications never block a successful review.
  }

  // Audit: final admin review on a claim. Captured for SUCCESS only —
  // failure paths above already returned without touching state.
  if (session.organizationId) {
    void writeAudit({
      organizationId: session.organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action:
        parsed.data.decision === "APPROVED"
          ? "claim.approve"
          : "claim.reject",
      status: "SUCCESS",
      summary:
        parsed.data.decision === "APPROVED"
          ? `Approved claim "${result.claimTitle}" (final review)`
          : `Rejected claim "${result.claimTitle}" (final review)`,
      targetType: "claim",
      targetId: parsed.data.claimId,
      metadata: parsed.data.reason ? { reason: parsed.data.reason } : null,
    })
  }

  return {
    ok: true,
    claimStatus: result.claimStatus,
    reviewerName: session.name,
    reason: parsed.data.reason,
  }
}

// ---------------------------------------------------------------------------
// Sync to Xero
// ---------------------------------------------------------------------------

/**
 * Push a REVIEWED claim to Xero. Currently STUBBED — only flips the
 * `xeroSyncStatus` field to SYNCED, optionally re-codes the chart of
 * account, and records when the sync happened. The actual Xero call
 * (createBill / spendMoney with the receipt attached) gets wired in
 * later — until then, the claim sits in the admin's "Ready to sync"
 * queue and disappears once they click Sync (good for E2E testing of
 * the workflow without burning Xero API quota).
 *
 * Permissions: admin only.
 */
export type SyncClaimInput = {
  claimId: string
  /** Optional final-stage COA override. Empty / undefined means "no
   *  change — keep what the employee picked at submission." */
  chartOfAccountId?: string
}

export type SyncClaimResult =
  | { ok: true; claimTitle: string }
  | { ok: false; status: number; message: string }

export async function syncClaimToXero({
  session,
  input,
}: {
  session: AuthenticatedSession
  input: SyncClaimInput
}): Promise<SyncClaimResult> {
  if (!isAdminRole(session.role)) {
    return { ok: false, status: 403, message: "Admins only." }
  }
  if (!input.claimId) {
    return { ok: false, status: 400, message: "Missing claim id." }
  }

  // STUB: real Xero call goes here. For now we just flip xeroSyncStatus
  // and (optionally) recode the COA. When the Xero call is added, it
  // returns a bill id we pass through `xeroBillId`.
  const result = await claimRepository.syncClaim({
    claimId: input.claimId,
    chartOfAccountId: input.chartOfAccountId?.trim() || undefined,
  })

  if (!result.ok) {
    const map = {
      DB_UNAVAILABLE: { status: 503, message: "Database is not configured." },
      NOT_FOUND: { status: 404, message: "Claim not found." },
      NOT_ACTIONABLE: {
        status: 409,
        message:
          "This claim isn't ready to sync — it must be REVIEWED and not yet synced.",
      },
    } as const
    const m = map[result.error]
    return { ok: false, status: m.status, message: m.message }
  }

  return { ok: true, claimTitle: result.claimTitle }
}
