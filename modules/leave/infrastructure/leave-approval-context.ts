import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import {
  resolveModuleChain,
  type ResolvedChainStep,
} from "@/modules/organization/application/services/approval-chain.service"

export type LeaveApprovalContext = {
  chain: ResolvedChainStep[]
  currentStep: number | null
}

/// Resolve the leave approval chain for an employee. Module = LEAVE.
/// Leave is org-wide (not project-scoped like attendance/OT), so we
/// resolve against the employee's primary team (alphabetically first
/// project) per the existing resolveModuleChain fallback.
export async function resolveLeaveApprovalContext(args: {
  employeeUserId: string
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
  lastReviewerId: string | null
}): Promise<LeaveApprovalContext> {
  const chain = await resolveModuleChain(args.employeeUserId, "LEAVE")

  if (args.status !== "PENDING" || chain.length === 0) {
    return { chain, currentStep: null }
  }
  if (!args.lastReviewerId) {
    return { chain, currentStep: 1 }
  }
  const reviewerStep = chain.findIndex((s) =>
    s.approvers.some((a) => a.approverId === args.lastReviewerId),
  )
  if (reviewerStep === -1) return { chain, currentStep: 1 }
  const next = reviewerStep + 2
  return { chain, currentStep: next > chain.length ? null : next }
}

/// True when the leave application should skip approval:
///   - actor is ADMIN/SUPERVISOR (auto-bypass), OR
///   - the resolved LEAVE chain for this employee is empty (no layers
///     above them ticked for LEAVE in their team's moduleConfig).
export async function shouldAutoApproveLeave(args: {
  employeeUserId: string
  role: string | null | undefined
}): Promise<boolean> {
  if (
    args.role === "ADMIN" ||
    args.role === "OWNER" ||
    args.role === "SUPERVISOR"
  )
    return true
  // Note: unlike attendance we don't bypass for project managers — leave
  // is org-wide, not project-scoped.
  const prisma = getPrismaClient()
  if (!prisma) return false
  const chain = await resolveModuleChain(args.employeeUserId, "LEAVE")
  return chain.length === 0
}
