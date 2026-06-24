import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * backfill-approval-chains.ts
 *
 * One-off: for every (employee, team) membership that has NO
 * ApprovalChainStep rows yet, auto-create them using the current
 * supervisors at every layer above the employee. Mirrors the
 * `assignTeamMember` auto-fill that landed alongside this script —
 * here we apply the same rule retroactively so existing data catches
 * up without forcing the admin to re-add every employee.
 *
 * Why it's needed: members added via Company Structure › Members
 * before the server-side auto-fill landed never got chain rows
 * (the per-employee Company tab only auto-fills the client form
 * state — the chain has to be SAVED via that tab to persist). The
 * visible symptoms are:
 *
 *   - Employee's Account Info shows "No supervisor assigned"
 *   - Claims submitted by that employee never appear in any
 *     supervisor's claims queue (no chain = nowhere to route)
 *   - Same for OT / leave approvals
 *
 * Memberships that ALREADY have a chain are left untouched — we
 * never overwrite admin's manual customization.
 *
 * Usage:
 *
 *   npm run db:backfill-approval-chains              # dry-run (no writes)
 *   npm run db:backfill-approval-chains -- --apply   # commit
 *
 *   # Limit to a single org by id.
 *   npm run db:backfill-approval-chains -- --apply --org=<orgId>
 */

const APPLY = process.argv.includes("--apply")
const orgArg = process.argv.find((a) => a.startsWith("--org="))
const ONLY_ORG_ID = orgArg ? orgArg.slice("--org=".length) : null

async function main() {
  const config = getDatabaseConnectionConfig()
  if (!config) throw new Error("Missing MySQL connection variables.")
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
    // -------------------------------------------------------------------
    // Pass 1 — User.role retro-fix.
    //
    // The role auto-sync inside `assignTeamMember` only fires forward,
    // so anyone added at layer ≥ 2 BEFORE that commit landed is stuck
    // with role = EMPLOYEE. The chain backfill below filters supervisors
    // by `User.role === "SUPERVISOR"`, so we must promote stuck users
    // first or they'll be invisible.
    // -------------------------------------------------------------------
    const usersToPromote = await prisma.user.findMany({
      where: {
        role: "EMPLOYEE",
        ...(ONLY_ORG_ID ? { organizationId: ONLY_ORG_ID } : {}),
        employeeProfile: {
          is: { teamMemberships: { some: { layer: { gte: 2 } } } },
        },
      },
      select: { id: true, name: true },
    })
    const promotedUserIds = new Set(usersToPromote.map((u) => u.id))
    if (usersToPromote.length > 0) {
      console.log(
        `\nFound ${usersToPromote.length} user(s) sitting at layer ≥ 2 but still flagged as EMPLOYEE:`,
      )
      for (const u of usersToPromote) console.log(`  - ${u.name}`)
      if (APPLY) {
        await prisma.user.updateMany({
          where: { id: { in: usersToPromote.map((u) => u.id) } },
          data: { role: "SUPERVISOR" },
        })
        console.log(`  ✓ Promoted to SUPERVISOR.`)
      } else {
        console.log(`  (would promote to SUPERVISOR on --apply)`)
      }
    }

    // -------------------------------------------------------------------
    // Pass 2 — chain backfill.
    //
    // Pull every membership grouped by team, with the team's layer
    // count + each member's user id + role. One query per org — cheap
    // even on the largest tenants because membership tables stay small.
    // -------------------------------------------------------------------
    const teams = await prisma.team.findMany({
      where: ONLY_ORG_ID
        ? { project: { organizationId: ONLY_ORG_ID } }
        : undefined,
      select: {
        id: true,
        name: true,
        layerCount: true,
        project: {
          select: { organizationId: true, organization: { select: { name: true } } },
        },
        memberships: {
          select: {
            id: true,
            layer: true,
            employeeProfile: {
              select: {
                id: true,
                user: { select: { id: true, name: true, role: true } },
              },
            },
          },
        },
      },
    })

    type Plan = {
      orgName: string
      teamName: string
      employeeName: string
      employeeId: string
      employeeLayer: number
      teamId: string
      steps: { step: number; approverIds: string[]; approverNames: string[] }[]
    }

    const plans: Plan[] = []
    let skippedHasChain = 0
    let skippedTopLayer = 0
    let skippedNoSupers = 0

    for (const team of teams) {
      // Group supervisors by layer for fast lookup. Anyone at layer ≥ 2
      // AND with User.role === "SUPERVISOR" can approve.
      const supersByLayer = new Map<
        number,
        { userId: string; userName: string; profileId: string }[]
      >()
      for (const m of team.memberships) {
        // Treat both existing SUPERVISORs and the EMPLOYEEs we just
        // identified for promotion as supervisors when building the
        // chain — otherwise dry-run output would lie (chain would
        // appear empty for orgs where the role hasn't been promoted
        // yet, even though --apply would fix the role too).
        const willBeSupervisor =
          m.employeeProfile.user.role === "SUPERVISOR" ||
          promotedUserIds.has(m.employeeProfile.user.id)
        if (!willBeSupervisor) continue
        const bucket = supersByLayer.get(m.layer) ?? []
        bucket.push({
          userId: m.employeeProfile.user.id,
          userName: m.employeeProfile.user.name,
          profileId: m.employeeProfile.id,
        })
        supersByLayer.set(m.layer, bucket)
      }

      // For each member, see if they already have a chain for this
      // team. If not, build one using the supers above their layer.
      for (const member of team.memberships) {
        if (member.layer >= team.layerCount) {
          skippedTopLayer += 1
          continue
        }
        const existing = await prisma.approvalChainStep.count({
          where: {
            employeeId: member.employeeProfile.user.id,
            teamId: team.id,
          },
        })
        if (existing > 0) {
          skippedHasChain += 1
          continue
        }

        const layersAbove: number[] = []
        for (let l = member.layer + 1; l <= team.layerCount; l += 1) {
          if ((supersByLayer.get(l)?.length ?? 0) > 0) layersAbove.push(l)
        }
        if (layersAbove.length === 0) {
          skippedNoSupers += 1
          continue
        }

        const steps = layersAbove.map((layer, idx) => {
          const supers = supersByLayer.get(layer)!.filter(
            (s) => s.profileId !== member.employeeProfile.id,
          )
          return {
            step: idx + 1,
            approverIds: supers.map((s) => s.userId),
            approverNames: supers.map((s) => s.userName),
          }
        }).filter((s) => s.approverIds.length > 0)
        if (steps.length === 0) {
          skippedNoSupers += 1
          continue
        }

        plans.push({
          orgName: team.project.organization.name,
          teamName: team.name,
          employeeName: member.employeeProfile.user.name,
          employeeId: member.employeeProfile.user.id,
          employeeLayer: member.layer,
          teamId: team.id,
          steps,
        })
      }
    }

    if (plans.length === 0) {
      console.log(
        `Scanned ${teams.length} team(s). No empty chains found — every member already has a chain (or no eligible supervisors above them).`,
      )
      return
    }

    console.log(
      `\n${APPLY ? "APPLYING" : "DRY RUN"} — will create chains for ${plans.length} (employee × team) pair(s):\n`,
    )

    for (const p of plans) {
      const stepStr = p.steps
        .map((s) => `step ${s.step} → [${s.approverNames.join(", ")}]`)
        .join("; ")
      console.log(
        `  [${p.orgName}] ${p.teamName} · L${p.employeeLayer} ${p.employeeName}: ${stepStr}`,
      )
    }
    console.log(
      `\nSkipped: ${skippedHasChain} already had a chain · ${skippedTopLayer} at top layer · ${skippedNoSupers} no supervisors above.`,
    )

    if (!APPLY) {
      console.log(`\nDry run complete. Re-run with --apply to commit.`)
      return
    }

    // Single transaction so partial failures don't leave half-populated
    // chains. createMany is cheap (~3 rows per employee typically), so
    // even hundreds of plans add up to a fast TX.
    await prisma.$transaction(async (tx) => {
      for (const p of plans) {
        await tx.approvalChainStep.createMany({
          data: p.steps.flatMap((s) =>
            s.approverIds.map((approverId) => ({
              employeeId: p.employeeId,
              teamId: p.teamId,
              approverId,
              step: s.step,
            })),
          ),
        })
      }
    })
    console.log(`\n✓ Created chains for ${plans.length} pair(s).`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
