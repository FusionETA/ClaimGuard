/**
 * Backfill script for the multi-org employee rollout.
 *
 * Populates:
 *   - EmployeeProfile.organizationId — from User.organizationId
 *   - EmployeeOrganization join rows — one per existing EmployeeProfile
 *
 * Idempotent: safe to re-run. Only touches rows that don't already have
 * the new field / relation set.
 *
 * Run once after `db:push` / `db:migrate` deploys the new schema and
 * before Phase 1b (the singular → plural refactor of User.employeeProfile).
 * Callers still read `user.employeeProfile` (singular) during Phase 1a —
 * this script ensures the new columns/rows are populated for when
 * later phases start reading from them.
 */

import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

async function main() {
  console.log("[backfill-employee-org] starting…")

  const config = getDatabaseConnectionConfig()
  if (!config) {
    throw new Error(
      "Missing MySQL connection variables. Copy .env.example to .env first.",
    )
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

  // Every current EmployeeProfile has exactly one User, and that User
  // has exactly one organizationId (until Phase 1b flips the schema).
  // So each profile maps 1:1 to an EmployeeOrganization row.
  const profiles = await prisma.employeeProfile.findMany({
    select: {
      id: true,
      userId: true,
      organizationId: true,
      user: { select: { organizationId: true } },
    },
  })

  console.log(`[backfill-employee-org] scanning ${profiles.length} profile(s)`)

  let profilesUpdated = 0
  let profilesSkipped = 0
  let joinRowsCreated = 0
  let joinRowsSkipped = 0

  for (const profile of profiles) {
    const orgId = profile.user.organizationId
    if (!orgId) {
      console.warn(
        `[backfill-employee-org] SKIP profile ${profile.id}: user has no organizationId`,
      )
      profilesSkipped += 1
      continue
    }

    // 1. Populate EmployeeProfile.organizationId if empty.
    if (profile.organizationId === null) {
      await prisma.employeeProfile.update({
        where: { id: profile.id },
        data: { organizationId: orgId },
      })
      profilesUpdated += 1
    } else if (profile.organizationId !== orgId) {
      console.warn(
        `[backfill-employee-org] MISMATCH profile ${profile.id}: profile.organizationId=${profile.organizationId} but user.organizationId=${orgId} — leaving profile alone`,
      )
      profilesSkipped += 1
    }

    // 2. Ensure an EmployeeOrganization join row exists.
    // Using employeeProfileId's unique constraint to skip duplicates
    // on re-run.
    const existing = await prisma.employeeOrganization.findUnique({
      where: { employeeProfileId: profile.id },
    })
    if (!existing) {
      await prisma.employeeOrganization.create({
        data: {
          userId: profile.userId,
          employeeProfileId: profile.id,
          organizationId: orgId,
        },
      })
      joinRowsCreated += 1
    } else {
      joinRowsSkipped += 1
    }
  }

  console.log("[backfill-employee-org] complete", {
    profilesUpdated,
    profilesSkipped,
    joinRowsCreated,
    joinRowsSkipped,
  })
}

main().catch((err) => {
  console.error("[backfill-employee-org] failed", err)
  process.exit(1)
})
