import "server-only"

import { getOrganizationPrismaClientSafe } from "@/modules/organization/infrastructure/organization.repository"
import {
  defaultModuleConfig,
  validateModuleConfig,
  type TeamModule,
  type TeamModuleConfig,
} from "@/modules/organization/domain/models"

/// One filtered chain step. Multi-approver: each step holds the SET of
/// approvers eligible to act at that step. Any one of them approving
/// completes the step.
export type ResolvedChainStep = {
  step: number
  approvers: Array<{
    approverId: string
    name: string
    email: string
    role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR"
  }>
}

/**
 * Resolve the approval chain for an employee filtered by a specific module's
 * team config, scoped to a project.
 *
 * Process:
 *   1. Find the employee's team membership for `projectId` (or fall back
 *      to their alphabetically-first project's team when projectId is
 *      omitted).
 *   2. Read the team's `moduleConfig[module]` (set of layer numbers that
 *      approve for this module).
 *   3. Fetch chain rows for that (employee, team), grouped by step.
 *   4. For each row: find the approver's layer in the same team; keep
 *      the row iff that layer is in the module config.
 *   5. Group remaining rows by step, then renumber steps from 1.
 *
 * Fallback: legacy chain rows with teamId IS NULL are returned unfiltered
 * (one approver per step).
 */
export async function resolveModuleChain(
  employeeId: string,
  module: TeamModule,
  projectId?: string,
): Promise<ResolvedChainStep[]> {
  const prisma = getOrganizationPrismaClientSafe()
  if (!prisma) return []

  const profile = await prisma.employeeProfile.findFirst({
    where: { userId: employeeId },
    include: {
      teamMemberships: {
        include: {
          team: {
            select: {
              id: true,
              projectId: true,
              layerCount: true,
              moduleConfig: true,
              project: { select: { name: true } },
            },
          },
        },
      },
    },
  })

  let membership = projectId
    ? profile?.teamMemberships.find((m) => m.team.projectId === projectId)
    : undefined

  if (!membership && profile && profile.teamMemberships.length > 0) {
    const sorted = [...profile.teamMemberships].sort((a, b) =>
      a.team.project.name.localeCompare(b.team.project.name),
    )
    membership = sorted[0]
  }

  // No team at all → legacy unfiltered chain (teamId IS NULL).
  if (!membership) {
    const legacyRows = await prisma.approvalChainStep.findMany({
      where: { employeeId, teamId: null },
      include: {
        approver: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
      orderBy: { step: "asc" },
    })
    // Each legacy row is its own step (single-approver legacy data).
    return legacyRows.map((s, i) => ({
      step: i + 1,
      approvers: [
        {
          approverId: s.approverId,
          name: s.approver.name,
          email: s.approver.email,
          role: s.approver.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR",
        },
      ],
    }))
  }

  const team = membership.team
  const cfgValidated = validateModuleConfig(team.moduleConfig, team.layerCount)
  const cfg: TeamModuleConfig = cfgValidated.ok
    ? cfgValidated.value
    : defaultModuleConfig(team.layerCount)
  const allowedLayers = new Set(cfg[module])

  const chainSteps = await prisma.approvalChainStep.findMany({
    where: { employeeId, teamId: team.id },
    include: {
      approver: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
    orderBy: [{ step: "asc" }],
  })

  if (chainSteps.length === 0) return []

  // Look up each approver's layer in the same team. Use that to apply
  // the module-config filter.
  const approverUserIds = Array.from(
    new Set(chainSteps.map((s) => s.approverId)),
  )
  const approverProfiles = await prisma.employeeProfile.findMany({
    where: { userId: { in: approverUserIds } },
    select: {
      userId: true,
      teamMemberships: {
        where: { teamId: team.id },
        select: { layer: true },
      },
    },
  })
  const layerByUserId = new Map<string, number>()
  for (const p of approverProfiles) {
    const m = p.teamMemberships[0]
    if (m) layerByUserId.set(p.userId, m.layer)
  }

  // Apply module filter, keeping rows whose approver layer is allowed.
  // Defensive: cross-team approvers (no layer match) are kept (legacy
  // behaviour — preserve the routing target).
  const kept = chainSteps.filter((s) => {
    const layer = layerByUserId.get(s.approverId)
    if (layer === undefined) return true
    return allowedLayers.has(layer)
  })

  // Group by original step number, then renumber consecutively.
  const byStep = new Map<number, typeof chainSteps>()
  for (const s of kept) {
    const list = byStep.get(s.step) ?? []
    list.push(s)
    byStep.set(s.step, list)
  }
  const sortedStepNumbers = Array.from(byStep.keys()).sort((a, b) => a - b)
  return sortedStepNumbers.map((origStep, i) => ({
    step: i + 1,
    approvers: (byStep.get(origStep) ?? []).map((s) => ({
      approverId: s.approverId,
      name: s.approver.name,
      email: s.approver.email,
      role: s.approver.role as "ADMIN" | "EMPLOYEE" | "SUPERVISOR",
    })),
  }))
}

// ---------------------------------------------------------------------------
// TODO(team-config): wire `resolveModuleChain` into OT / LEAVE / ATTENDANCE
// routing once those modules grow explicit chain walks.
// ---------------------------------------------------------------------------
