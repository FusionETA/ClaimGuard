import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * One-off backfill: seed one `EmploymentStint` row per existing
 * `PayrollProfile` so historical employee-tenure state matches the
 * new schema.
 *
 * Idempotent — profiles that already have any stint row are skipped.
 * Safe to re-run at any time (during a phased rollout, on migrations
 * to new environments, etc.).
 *
 * Seed rules:
 *   - `joinDate` = PayrollProfile.joinDate, or a `2000-01-01` sentinel
 *     when null (very old legacy rows with no join date filled in —
 *     the sentinel keeps the stint's period-window predicate happy for
 *     any run in the last 25 years).
 *   - `leaveDate` = PayrollProfile.leaveDate when the profile is
 *     archived (isArchived = true) OR when leaveDate is set on an
 *     un-archived profile (someone typed the last day but hasn't been
 *     archived yet). Otherwise null (currently open).
 *   - `startReason` = "Migrated from legacy joinDate" so the history
 *     card can tell backfilled rows apart from real subsequent stints.
 *   - `endReason` mirrors PayrollProfile.archiveReason when the row
 *     is closed, otherwise null.
 *
 * Usage:
 *   npm run backfill:stints
 * or:
 *   npx tsx prisma/backfill-stints.ts
 */
const LEGACY_JOIN_DATE_SENTINEL = new Date("2000-01-01T00:00:00.000Z")

async function main() {
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

  try {
    const profiles = await prisma.payrollProfile.findMany({
      select: {
        id: true,
        employeeProfileId: true,
        joinDate: true,
        leaveDate: true,
        isArchived: true,
        archiveReason: true,
      },
    })

    console.log(`[backfill-stints] scanning ${profiles.length} payroll profiles`)

    let created = 0
    let skipped = 0
    let missing = 0

    for (const p of profiles) {
      if (!p.employeeProfileId) {
        missing += 1
        continue
      }
      const existing = await prisma.employmentStint.findFirst({
        where: { employeeProfileId: p.employeeProfileId },
        select: { id: true },
      })
      if (existing) {
        skipped += 1
        continue
      }

      const joinDate = p.joinDate ?? LEGACY_JOIN_DATE_SENTINEL
      const shouldBeClosed = p.isArchived === true && p.leaveDate != null
      const leaveDate = shouldBeClosed ? p.leaveDate : null

      await prisma.employmentStint.create({
        data: {
          employeeProfileId: p.employeeProfileId,
          joinDate,
          leaveDate,
          startReason: "Migrated from legacy joinDate",
          endReason: shouldBeClosed
            ? p.archiveReason ?? "Migrated from legacy leaveDate"
            : null,
        },
      })
      created += 1
    }

    console.log(
      `[backfill-stints] done — created=${created} skipped=${skipped} missing_employee_profile=${missing}`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error("[backfill-stints] failed", err)
  process.exit(1)
})
