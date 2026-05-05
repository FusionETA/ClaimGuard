import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import {
  resolveModuleChain,
  type ResolvedChainStep,
} from "@/modules/organization/application/services/approval-chain.service"
import type { ApprovalKind } from "@/modules/attendance/domain/models"
import type { TeamModule } from "@/modules/organization/domain/models"

export type ApprovalContext = {
  /** The resolved + module-filtered chain (length ≥ 1 when not auto-approved). */
  chain: ResolvedChainStep[]
  /** 1-indexed; null when the request is finalised. */
  currentStep: number | null
}

export function kindToModule(kind: ApprovalKind): TeamModule {
  return kind === "OT" ? "OT" : "ATTENDANCE"
}

/**
 * Resolve the attendance/OT chain for a request, then compute which step
 * is currently waiting for review based on `status` + `reviewerId`.
 *
 * Falls back to the employee's direct supervisor (single-step chain) if
 * the team has no layers ticked for this module.
 */
export async function resolveApprovalContext(args: {
  requestId: string
  employeeId: string
  kind: ApprovalKind
  status: "PENDING" | "APPROVED" | "REJECTED"
  reviewerId: string | null
  /** Project the event was clocked into (for chain selection). May be null. */
  projectId: string | null
}): Promise<ApprovalContext> {
  // Finalised requests don't have a "current" step — but we still resolve
  // the chain so the UI can show totalSteps.
  let chain = await resolveModuleChain(
    args.employeeId,
    kindToModule(args.kind),
    args.projectId ?? undefined,
  )

  if (chain.length === 0) {
    // Empty chain → fall back to the direct supervisor.
    chain = await resolveDirectSupervisorChain(args.employeeId)
  }

  if (args.status !== "PENDING" || chain.length === 0) {
    return { chain, currentStep: null }
  }

  if (!args.reviewerId) {
    return { chain, currentStep: 1 }
  }

  // Find which step the last reviewer was on, advance by one.
  const reviewerStep = chain.findIndex((s) =>
    s.approvers.some((a) => a.approverId === args.reviewerId),
  )
  if (reviewerStep === -1) {
    // Reviewer isn't part of the resolved chain (can happen if config changed).
    // Treat as still on step 1 to be safe.
    return { chain, currentStep: 1 }
  }
  const next = reviewerStep + 2 // +1 for 1-indexed, +1 for next step
  return { chain, currentStep: next > chain.length ? null : next }
}

async function resolveDirectSupervisorChain(
  employeeId: string,
): Promise<ResolvedChainStep[]> {
  const prisma = getPrismaClient()
  if (!prisma) return []
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId: employeeId },
    select: {
      supervisor: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  })
  if (!profile?.supervisor) return []
  return [
    {
      step: 1,
      approvers: [
        {
          approverId: profile.supervisor.id,
          name: profile.supervisor.name,
          email: profile.supervisor.email,
          role: profile.supervisor.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR",
        },
      ],
    },
  ]
}

/**
 * Returns true when the actor's clock-in/out/break/OT request should
 * skip approval entirely. Today: ADMINs and SUPERVISORs always bypass;
 * project managers (PM table or legacy XeroProject.projectManagerId) bypass
 * for the project they manage.
 */
export async function isAutoApprovingActor(args: {
  employeeId: string
  role: string | null | undefined
  projectId: string | null
}): Promise<boolean> {
  if (args.role === "ADMIN" || args.role === "SUPERVISOR") return true
  if (!args.projectId) return false
  const prisma = getPrismaClient()
  if (!prisma) return false
  const [pm, project] = await Promise.all([
    prisma.projectManager.findFirst({
      where: { projectId: args.projectId, userId: args.employeeId },
      select: { id: true },
    }),
    prisma.xeroProject.findUnique({
      where: { id: args.projectId },
      select: { projectManagerId: true },
    }),
  ])
  if (pm) return true
  if (project?.projectManagerId === args.employeeId) return true
  return false
}
