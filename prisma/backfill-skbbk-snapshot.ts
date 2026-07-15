import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * backfill-skbbk-snapshot.ts
 *
 * One-off migration companion for the SKBBK auto-calc → per-employee
 * opt-in rework. See project memory `skbbk-skim-lindung-24-jam.md` for
 * the full design.
 *
 * The rework added `Payslip.contributeToSkbbk` as a frozen snapshot
 * of the employee's opt-in decision at time of run — so re-opening a
 * submitted run to fix something unrelated (bonus adjustment, claim
 * correction) preserves the SKBBK line instead of silently unwinding
 * it. Prisma's `@default(false)` on the new column fills existing rows
 * with FALSE, which is wrong for any payslip that already fired SKBBK
 * under the old auto-calc code — a subsequent recompute would see
 * "not opted in" and drop the RM 18.75 (or whatever) SKBBK line, even
 * though it was already remitted to PERKESO.
 *
 * This script flips the snapshot TRUE for every payslip where SKBBK
 * was actually deducted (`skbbkEmployee > 0`) — preserving history
 * without touching payslips that were correctly zero.
 *
 * Safe to re-run — idempotent. The WHERE clause is precise, and
 * flipping an already-TRUE snapshot to TRUE is a no-op.
 *
 * Usage:
 *
 *   npm run db:backfill-skbbk-snapshot              # dry-run (no writes)
 *   npm run db:backfill-skbbk-snapshot -- --apply   # commit the changes
 */

const APPLY = process.argv.includes("--apply")

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
    // Count everything we'd touch first — the WHERE `skbbkEmployee > 0`
    // + `contributeToSkbbk = false` combo isolates the "auto-calc
    // already ran but the new snapshot hasn't been set yet" cohort.
    const candidates = await prisma.payslip.count({
      where: {
        skbbkEmployee: { gt: 0 },
        contributeToSkbbk: false,
      },
    })
    console.log(
      `Found ${candidates} payslip(s) with skbbkEmployee > 0 and contributeToSkbbk = false`,
    )
    if (candidates === 0) {
      console.log("Nothing to backfill. Exiting.")
      return
    }

    if (!APPLY) {
      console.log(
        "\nDry-run — pass --apply to actually flip contributeToSkbbk = TRUE on the above rows.",
      )
      return
    }

    const result = await prisma.payslip.updateMany({
      where: {
        skbbkEmployee: { gt: 0 },
        contributeToSkbbk: false,
      },
      data: { contributeToSkbbk: true },
    })
    console.log(`Updated ${result.count} payslip(s). Done.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
