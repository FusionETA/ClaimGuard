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
 * If the team has no layers ticked for this module, the chain comes back
 * empty — the caller treats that as "auto-approved" (no supervisor
 * review needed for this kind of event in this team's config).
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
  const chain = await resolveModuleChain(
    args.employeeId,
    kindToModule(args.kind),
    args.projectId ?? undefined,
  )

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

/**
 * Returns true when the request should skip approval:
 *   - the actor bypasses (ADMIN/SUPERVISOR/PM — see `isAutoApprovingActor`),
 *   - OR the team has the per-event approval flag turned off for this
 *     clock/break kind (admins toggle these on the Company Structure
 *     team editor),
 *   - OR the resolved approval chain for this (employee, module, project)
 *     is empty (team has no layers above the employee, e.g. a 1-layer team).
 *
 * `breakSubtype` is only consulted when `kind === "BREAK"` — it routes
 * the gate to the team's `requireBreakStartApproval` vs
 * `requireBreakEndApproval` flag.
 */
export async function shouldAutoApprove(args: {
  employeeId: string
  role: string | null | undefined
  projectId: string | null
  kind: ApprovalKind
  breakSubtype?: "start" | "end"
}): Promise<boolean> {
  if (await isAutoApprovingActor(args)) return true
  if (
    !(await isAttendanceApprovalRequired({
      employeeId: args.employeeId,
      projectId: args.projectId,
      kind: args.kind,
      breakSubtype: args.breakSubtype,
    }))
  ) {
    return true
  }
  const chain = await resolveModuleChain(
    args.employeeId,
    kindToModule(args.kind),
    args.projectId ?? undefined,
  )
  return chain.length === 0
}

/**
 * Look up the employee's team for the given project (falling back to
 * their alphabetically-first project's team when projectId is absent)
 * and read whether the team requires approval for this event kind.
 *
 * Returns true (= approval required) when:
 *   - the employee has no team membership (legacy / unmigrated rows),
 *   - the kind isn't gated by these flags (`OT` is never gated here),
 *   - or the team's flag for this kind is true.
 *
 * Returns false only when the team explicitly has the matching flag
 * disabled — in which case the caller should auto-approve.
 */
async function isAttendanceApprovalRequired(args: {
  employeeId: string
  projectId: string | null
  kind: ApprovalKind
  breakSubtype?: "start" | "end"
}): Promise<boolean> {
  // OT is governed by the existing ATTENDANCE/OT chain — not these flags.
  if (args.kind === "OT") return true
  const prisma = getPrismaClient()
  if (!prisma) return true
  const profile = await prisma.employeeProfile.findFirst({
    where: {
      userId: args.employeeId,
      // Scope to the profile in the org that owns the project.
      ...(args.projectId
        ? { organization: { projects: { some: { id: args.projectId } } } }
        : {}),
    },
    select: {
      teamMemberships: {
        select: {
          team: {
            select: {
              projectId: true,
              requireClockInApproval: true,
              requireClockOutApproval: true,
              requireBreakStartApproval: true,
              requireBreakEndApproval: true,
              project: { select: { name: true } },
            },
          },
        },
      },
    },
  })
  if (!profile || profile.teamMemberships.length === 0) return true

  // Pick the membership for the event's project; otherwise fall back to
  // the alphabetically-first project's team (same selection rule the
  // chain resolver uses, so the gate and the chain agree).
  let membership = args.projectId
    ? profile.teamMemberships.find((m) => m.team.projectId === args.projectId)
    : undefined
  if (!membership) {
    const sorted = [...profile.teamMemberships].sort((a, b) =>
      a.team.project.name.localeCompare(b.team.project.name),
    )
    membership = sorted[0]
  }
  const t = membership.team
  if (args.kind === "CLOCK_IN") return t.requireClockInApproval
  if (args.kind === "CLOCK_OUT") return t.requireClockOutApproval
  if (args.kind === "BREAK") {
    if (args.breakSubtype === "start") return t.requireBreakStartApproval
    if (args.breakSubtype === "end") return t.requireBreakEndApproval
    // Unknown subtype on a BREAK request — default to required so we
    // don't accidentally auto-approve.
    return true
  }
  return true
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
  if (
    args.role === "ADMIN" ||
    args.role === "OWNER" ||
    args.role === "SUPERVISOR"
  )
    return true
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
