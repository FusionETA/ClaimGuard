import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * Backfill script: creates a "Default Team" per XeroProject that has any
 * employees, and inserts EmployeeTeamMembership rows positioning each
 * employee at the correct layer derived from existing ApprovalChainStep
 * data.
 *
 * The script is idempotent — re-running will not clobber an admin's
 * subsequent edits to teams or memberships.
 *
 * Layer assignment logic:
 *   1. For each employee, walk every chain they participate in:
 *      - Chain owner (Claim.employeeId == user) → L1
 *      - Approver at step N → L(N + 1)
 *      Take the MAX layer encountered.
 *   2. Fallback for users with no chain participation:
 *      - SUPERVISOR role → L2 (orphan supervisor default)
 *      - EMPLOYEE role → L1
 *
 * Team layerCount = MAX(longest chain length) + 1, floor 1, default 3 if
 * any employee has a 2-step chain (matches Brand Launch Event spec).
 *
 * moduleConfig defaults to all-layers-approve for every module so existing
 * approval routing keeps working unchanged.
 */

const TEAM_NAME = "Default Team"
const MODULES = ["CLAIMS", "OT", "LEAVE", "ATTENDANCE"] as const

function defaultModuleConfig(layerCount: number) {
  const layers = Array.from({ length: layerCount }, (_, i) => i + 1)
  const cfg: Record<(typeof MODULES)[number], number[]> = {
    CLAIMS: [],
    OT: [],
    LEAVE: [],
    ATTENDANCE: [],
  }
  for (const m of MODULES) {
    cfg[m] = layers.slice()
  }
  return cfg
}

async function main() {
  const config = getDatabaseConnectionConfig()
  if (!config) {
    throw new Error("Missing MySQL connection variables. Copy .env.example to .env first.")
  }

  const adapter = new PrismaMariaDb({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 5,
    ssl: config.ssl,
  })

  const prisma = new PrismaClient({ adapter })

  try {
    // 1. Pull every project + every employee profile + their chain participation.
    const projects = await prisma.xeroProject.findMany({
      select: {
        id: true,
        name: true,
        organizationId: true,
        assignedEmployees: {
          select: { employeeProfileId: true },
        },
      },
    })

    const profiles = await prisma.employeeProfile.findMany({
      select: {
        id: true,
        userId: true,
        project: true,
        user: {
          select: { id: true, name: true, role: true, organizationId: true },
        },
        projectAssignments: {
          select: { projectId: true },
        },
      },
    })

    const chainSteps = await prisma.approvalChainStep.findMany({
      select: {
        employeeId: true,
        approverId: true,
        step: true,
      },
    })

    // Index chain participation by user id.
    // For each user, collect (chainOwnerId, layer) tuples representing every
    // (chain, layer) the user touches. Layer = 1 for chain owner; for an
    // approver at step S, layer = S + 1.
    type Participation = { chainOwnerId: string; layer: number }
    const participation = new Map<string, Participation[]>()

    function pushPart(userId: string, p: Participation) {
      const list = participation.get(userId) ?? []
      list.push(p)
      participation.set(userId, list)
    }

    // Owner = L1.
    const distinctOwners = new Set<string>()
    for (const step of chainSteps) {
      if (!distinctOwners.has(step.employeeId)) {
        distinctOwners.add(step.employeeId)
        pushPart(step.employeeId, { chainOwnerId: step.employeeId, layer: 1 })
      }
      pushPart(step.approverId, {
        chainOwnerId: step.employeeId,
        layer: step.step + 1,
      })
    }

    // Length of each chain (longest step number per chain owner).
    const chainLength = new Map<string, number>()
    for (const step of chainSteps) {
      const cur = chainLength.get(step.employeeId) ?? 0
      if (step.step > cur) chainLength.set(step.employeeId, step.step)
    }

    // Build project membership: which employee profiles belong to which project.
    // Sources: EmployeeProjectAssignment (FK), then legacy `project` name match.
    const profilesByProject = new Map<string, Set<string>>() // projectId → Set<profileId>
    function addToProject(projectId: string, profileId: string) {
      const set = profilesByProject.get(projectId) ?? new Set<string>()
      set.add(profileId)
      profilesByProject.set(projectId, set)
    }
    for (const project of projects) {
      for (const assignment of project.assignedEmployees) {
        addToProject(project.id, assignment.employeeProfileId)
      }
    }

    // Legacy `project` string → project id by (org, name) match.
    const projectByOrgAndName = new Map<string, string>() // `${orgId}|${trimmedName}` → projectId
    for (const project of projects) {
      projectByOrgAndName.set(`${project.organizationId}|${project.name.trim()}`, project.id)
    }
    for (const profile of profiles) {
      const legacy = profile.project?.trim()
      if (!legacy) continue
      const orgId = profile.user.organizationId
      if (!orgId) continue
      const matchProjectId = projectByOrgAndName.get(`${orgId}|${legacy}`)
      if (matchProjectId) {
        addToProject(matchProjectId, profile.id)
      }
    }

    // 2. For each project that has any employees, upsert Team and memberships.
    let teamsCreated = 0
    let teamsExisting = 0
    let membershipsCreated = 0
    let membershipsSkipped = 0

    for (const project of projects) {
      const memberProfileIds = profilesByProject.get(project.id)
      if (!memberProfileIds || memberProfileIds.size === 0) {
        console.log(`  · skipping ${project.name} (${project.id}) — no employees`)
        continue
      }

      // Compute layerCount: max chain length among members + 1.
      let maxChainLen = 0
      for (const profileId of memberProfileIds) {
        const profile = profiles.find((p) => p.id === profileId)
        if (!profile) continue
        const userId = profile.user.id
        const owned = chainLength.get(userId) ?? 0
        if (owned > maxChainLen) maxChainLen = owned
      }
      const layerCount = Math.max(1, maxChainLen + 1)

      // Upsert team. update: {} so admin edits aren't clobbered on re-run.
      const existing = await prisma.team.findUnique({
        where: { projectId_name: { projectId: project.id, name: TEAM_NAME } },
        select: { id: true, layerCount: true },
      })

      let teamId: string
      let teamLayerCount: number
      if (existing) {
        teamId = existing.id
        teamLayerCount = existing.layerCount
        teamsExisting += 1
      } else {
        const created = await prisma.team.create({
          data: {
            projectId: project.id,
            name: TEAM_NAME,
            layerCount,
            moduleConfig: defaultModuleConfig(layerCount),
          },
          select: { id: true, layerCount: true },
        })
        teamId = created.id
        teamLayerCount = created.layerCount
        teamsCreated += 1
        console.log(
          `  ✓ created team for ${project.name} (layerCount=${layerCount})`,
        )
      }

      // Upsert memberships.
      for (const profileId of memberProfileIds) {
        const profile = profiles.find((p) => p.id === profileId)
        if (!profile) continue

        const already = await prisma.employeeTeamMembership.findUnique({
          where: {
            employeeProfileId_teamId: {
              employeeProfileId: profile.id,
              teamId,
            },
          },
          select: { id: true },
        })

        if (already) {
          membershipsSkipped += 1
          continue
        }

        // Layer assignment.
        const parts = participation.get(profile.user.id) ?? []
        let layer: number
        if (parts.length > 0) {
          layer = parts.reduce((max, p) => (p.layer > max ? p.layer : max), 0)
        } else {
          layer = profile.user.role === "SUPERVISOR" ? 2 : 1
        }
        // Clamp into the team's range.
        if (layer > teamLayerCount) layer = teamLayerCount
        if (layer < 1) layer = 1

        await prisma.employeeTeamMembership.create({
          data: {
            employeeProfileId: profile.id,
            teamId,
            layer,
          },
        })
        membershipsCreated += 1
        console.log(
          `    + ${profile.user.name} (${profile.user.role}) → L${layer}`,
        )
      }
    }

    // 3. Backfill ApprovalChainStep.teamId for existing rows where it's null.
    //    Today every chain-having employee has exactly one team membership,
    //    so the assignment is deterministic. If an employee has multiple
    //    team memberships, fall back to their first one (alphabetical by
    //    project name) so the chain is at least pinned somewhere.
    const orphanedChainSteps = await prisma.approvalChainStep.findMany({
      where: { teamId: null },
      select: { id: true, employeeId: true, step: true },
    })

    let chainStepsBackfilled = 0
    let chainStepsSkipped = 0
    for (const step of orphanedChainSteps) {
      const memberships = await prisma.employeeTeamMembership.findMany({
        where: { employeeProfile: { userId: step.employeeId } },
        include: {
          team: { include: { project: { select: { name: true } } } },
        },
      })
      if (memberships.length === 0) {
        chainStepsSkipped += 1
        continue
      }
      memberships.sort((a, b) =>
        a.team.project.name.localeCompare(b.team.project.name),
      )
      const targetTeamId = memberships[0]!.teamId
      await prisma.approvalChainStep.update({
        where: { id: step.id },
        data: { teamId: targetTeamId },
      })
      chainStepsBackfilled += 1
    }

    console.log("")
    console.log(`Backfill complete.`)
    console.log(`  Teams created:       ${teamsCreated}`)
    console.log(`  Teams already there: ${teamsExisting}`)
    console.log(`  Memberships created: ${membershipsCreated}`)
    console.log(`  Memberships skipped: ${membershipsSkipped}`)
    console.log(`  Chain steps teamId-backfilled: ${chainStepsBackfilled}`)
    console.log(`  Chain steps with no team membership (left null): ${chainStepsSkipped}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
