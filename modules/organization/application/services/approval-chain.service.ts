import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import {
  defaultModuleConfig,
  validateModuleConfig,
  type TeamModule,
  type TeamModuleConfig,
} from "@/modules/organization/domain/models"

/// One step of the module-filtered approval chain. `step` is 1-indexed and
/// re-numbered after filtering, so consumers can apply the existing
/// "currentStep" walking logic without modification.
export type ResolvedChainStep = {
  step: number
  approverId: string
  name: string
  email: string
  role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR"
}

/**
 * Resolve the approval chain for an employee filtered by a specific module's
 * team config, scoped to a project.
 *
 * Process:
 *   1. Find the employee's team membership for `projectId` (or fall back
 *      to their alphabetically-first project's team when projectId is
 *      omitted — used by today's claim flow which doesn't yet stamp a
 *      project on the Claim row).
 *   2. Read that team's `moduleConfig[module]`.
 *   3. Fetch the chain rows scoped to that team (`teamId` matches).
 *   4. Filter to steps whose approver layer is in moduleConfig[module].
 *   5. Renumber steps from 1 in the filtered list.
 *
 * Fallback: if the employee has no team membership at all (legacy or new
 * hire pre-config), we use any unscoped legacy chain rows (teamId = null)
 * unfiltered, so existing approval flows keep working.
 */
export async function resolveModuleChain(
  employeeId: string,
  module: TeamModule,
  projectId?: string,
): Promise<ResolvedChainStep[]> {
  const prisma = getPrismaClient()
  if (!prisma) return []

  // Find the relevant team membership.
  const profile = await prisma.employeeProfile.findUnique({
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

  // Fallback: if no projectId given (or projectId not found in their teams),
  // use the alphabetically-first team by project name. Stable and
  // deterministic for today's project-less claim submissions.
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
    return legacyRows.map((s, i) => ({
      step: i + 1,
      approverId: s.approverId,
      name: s.approver.name,
      email: s.approver.email,
      role: s.approver.role as ResolvedChainStep["role"],
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
    orderBy: { step: "asc" },
  })

  if (chainSteps.length === 0) return []

  // Look up each approver's layer in the same team.
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

  const filtered: ResolvedChainStep[] = []
  for (const s of chainSteps) {
    const layer = layerByUserId.get(s.approverId)
    // Defensive: keep cross-team approvers if the team config can't place
    // them. Prevents accidentally cutting an approver from the chain just
    // because their team membership lookup failed.
    if (layer === undefined) {
      filtered.push({
        step: filtered.length + 1,
        approverId: s.approverId,
        name: s.approver.name,
        email: s.approver.email,
        role: s.approver.role as ResolvedChainStep["role"],
      })
      continue
    }
    if (!allowedLayers.has(layer)) continue
    filtered.push({
      step: filtered.length + 1,
      approverId: s.approverId,
      name: s.approver.name,
      email: s.approver.email,
      role: s.approver.role as ResolvedChainStep["role"],
    })
  }

  return filtered
}

// ---------------------------------------------------------------------------
// TODO(team-config): wire `resolveModuleChain` into OT / LEAVE / ATTENDANCE
// routing once those modules grow explicit chain walks. Today only CLAIMS
// does explicit chain walking (claim.repository.ts). The OT / LEAVE /
// ATTENDANCE flows in modules/attendance/* deliver to the supervisorId
// pointer directly without consulting a chain.
// ---------------------------------------------------------------------------
