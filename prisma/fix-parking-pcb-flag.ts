import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * fix-parking-pcb-flag.ts
 *
 * One-off correction for parking allowance rows that the YTD importer
 * wrote with `subjectToPcb = true`. Parking is ALWAYS PCB-exempt (LHDN
 * Public Ruling 5/2019 §7.2.2), so the flag should be false — with it
 * true, the YTD aggregator (`getYtdForEmployee`, which sums
 * `subjectToPcb = true` allowances into Y) overstates every later
 * month's taxable income and, eventually, Form EA.
 *
 * The importer bug is fixed going forward (payroll-ytd-import.service.ts
 * now maps the Parking column to `allowance_parking` and sources
 * `subjectToPcb` from the category meta). This script repairs rows that
 * were ALREADY imported wrong.
 *
 * Match: kind = ALLOWANCE, subjectToPcb = true, and either the label
 * contains "arking" (covers "Parking allowance") or category is already
 * `allowance_parking`. Fix: subjectToPcb → false, category →
 * allowance_parking.
 *
 * NOTE: this intentionally mutates historical (submitted) payslip
 * snapshots — normally immutable — because it corrects bad imported
 * data, not a rate change. It does NOT recompute PCB on those months;
 * it only corrects the YTD carry-forward that FUTURE months read. Re-run
 * the affected employees' next DRAFT run to see the corrected Y.
 *
 * Idempotent — re-running after --apply finds nothing (the WHERE needs
 * subjectToPcb = true).
 *
 * Usage:
 *   npx tsx prisma/fix-parking-pcb-flag.ts              # dry-run (no writes)
 *   npx tsx prisma/fix-parking-pcb-flag.ts -- --apply   # commit the changes
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

  const where = {
    kind: "ALLOWANCE" as const,
    subjectToPcb: true,
    OR: [
      { label: { contains: "arking" } },
      { category: "allowance_parking" },
    ],
  }

  try {
    const rows = await prisma.payslipLineItem.findMany({
      where,
      select: {
        id: true,
        label: true,
        category: true,
        amount: true,
        payslip: {
          select: {
            snapshotName: true,
            payrollRun: {
              select: {
                organizationId: true,
                status: true,
                periodYear: true,
                periodMonth: true,
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    })

    if (rows.length === 0) {
      console.log("✅ No mis-flagged parking allowance rows found. Nothing to do.")
      return
    }

    console.log(
      `Found ${rows.length} parking allowance row(s) with subjectToPcb = true:\n`,
    )
    let total = 0
    for (const r of rows) {
      const p = r.payslip
      const run = p.payrollRun
      total += Number(r.amount)
      console.log(
        `  [org ${run?.organizationId ?? "?"}] ${p.snapshotName} ` +
          `${run?.periodYear ?? "?"}-${String(run?.periodMonth ?? 0).padStart(2, "0")} · ` +
          `${r.label} · RM ${Number(r.amount).toFixed(2)} · ` +
          `category=${r.category ?? "null"} · run=${run?.status ?? "?"}`,
      )
    }
    console.log(
      `\n  Total mis-taxed parking amount: RM ${total.toFixed(2)} ` +
        `across ${rows.length} row(s).`,
    )

    if (!APPLY) {
      console.log(
        "\nDry-run — pass -- --apply to set subjectToPcb = false and " +
          "category = 'allowance_parking' on the above rows.",
      )
      return
    }

    const result = await prisma.payslipLineItem.updateMany({
      where,
      data: { subjectToPcb: false, category: "allowance_parking" },
    })
    console.log(`\n✅ Updated ${result.count} row(s). Done.`)
    console.log(
      "Re-open the affected employees' next DRAFT payroll run to pick up " +
        "the corrected YTD (Y).",
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
