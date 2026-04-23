import "server-only"

import { z } from "zod"

import { clearEmployeeStore } from "@/lib/app-store"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { loadEmployeeData } from "@/lib/load-user-data"
import { invalidateAdminStore } from "@/modules/claims/application/services/admin-portal.service"
import type {
  ClaimRecord,
  ClaimStatus,
} from "@/modules/claims/domain/models"
import { claimCategories } from "@/modules/claims/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

export const createClaimSchema = z.object({
  title: z.string().min(3, "Give the claim a short title."),
  category: z.enum(claimCategories),
  amount: z.coerce.number().positive("Amount must be greater than zero."),
  spentAt: z.string().min(1, "Select the expense date."),
  description: z.string().min(12, "Add enough detail for the reviewer."),
  receiptUrl: z.string().optional(),
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

export type CreateClaimInput = {
  title: string
  category: string
  amount: string | number
  spentAt: string
  description: string
  receiptUrl?: string
}

export type CreateClaimServiceResult =
  | {
      ok: true
    }
  | {
      ok: false
      status: number
      message: string
      values: CreateClaimInput
      fieldErrors?: {
        title?: string
        category?: string
        amount?: string
        spentAt?: string
        description?: string
        receiptUrl?: string
      }
    }

export type ReviewClaimServiceResult =
  | {
      ok: true
      claimStatus: "APPROVED" | "REJECTED"
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
    session.role === "ADMIN"
      ? await claimRepository.getAllClaims()
      : await claimRepository.getClaimsByEmployee(session.email)

  if (!status || status === "ALL") {
    return claims
  }

  return claims.filter((claim) =>
    status === "PENDING"
      ? claim.status === "PENDING" || claim.status === "SUBMITTED"
      : claim.status === status
  )
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

  if (!status || status === "ALL") {
    return claims
  }

  return claims.filter((claim) =>
    status === "PENDING"
      ? claim.status === "PENDING" || claim.status === "SUBMITTED"
      : claim.status === status
  )
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

  const parsed = createClaimSchema.safeParse(input)

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors

    return {
      ok: false,
      status: 400,
      message: "Please review the highlighted fields and try again.",
      values: input,
      fieldErrors: {
        title: fieldErrors.title?.[0],
        category: fieldErrors.category?.[0],
        amount: fieldErrors.amount?.[0],
        spentAt: fieldErrors.spentAt?.[0],
        description: fieldErrors.description?.[0],
        receiptUrl: fieldErrors.receiptUrl?.[0],
      },
    }
  }

  const [employeeId, reviewerId] = await Promise.all([
    claimRepository.getUserId(session.email, "EMPLOYEE"),
    claimRepository.getFirstAdminId(),
  ])

  if (!employeeId) {
    return {
      ok: false,
      status: 404,
      message: "Employee account not found. Contact your administrator.",
      values: input,
    }
  }

  const ok = await claimRepository.createClaim({
    claimNumber: `CLM-${Date.now().toString().slice(-5)}`,
    title: parsed.data.title,
    description: parsed.data.description,
    category: parsed.data.category,
    amount: parsed.data.amount.toFixed(2),
    currency: "USD",
    spentAt: new Date(parsed.data.spentAt),
    receiptUrl: parsed.data.receiptUrl || undefined,
    employeeId,
    reviewerId,
  })

  if (!ok) {
    return {
      ok: false,
      status: 503,
      message: "Database is not configured. Contact your administrator.",
      values: input,
    }
  }

  await loadEmployeeData(session.email)
  invalidateAdminStore()

  return { ok: true }
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

  clearEmployeeStore(result.employeeEmail)

  try {
    await loadEmployeeData(result.employeeEmail)
  } catch {
    // If cache refresh fails, the next page/API read will load from DB directly.
  }

  invalidateAdminStore()

  return {
    ok: true,
    claimStatus: parsed.data.decision,
    reviewerName: session.name,
    reason: parsed.data.reason,
  }
}
