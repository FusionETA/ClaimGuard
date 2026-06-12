/**
 * One-off backfill: stamp `xeroTrackingCategoryId` on every existing
 * `XeroProject` row that was synced from a Xero tracking option but
 * pre-dates the column.
 *
 * Why: project listings now scope by the connection's currently-active
 * tracking category so swapping categories hides stale rows from the
 * picker. Existing rows have `xeroTrackingCategoryId = NULL` and would
 * vanish from the picker as soon as the next sync runs (because they
 * wouldn't match the connection's active category). This script
 * backfills them with whatever category the org currently uses.
 *
 * Safe to re-run — only touches rows where the column is still NULL.
 *
 * Run:   npx tsx prisma/backfill-tracking-category-id.ts
 */
import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

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
    // Rows that came from a Xero tracking option (have
    // `xeroTrackingOptionId`) but don't yet have the category id
    // recorded. We don't touch manual rows or legacy `/Projects`-API
    // rows — those have `xeroTrackingOptionId = NULL` and the listing
    // query treats them as always-visible.
    const targets = await prisma.xeroProject.findMany({
      where: {
        xeroTrackingOptionId: { not: null },
        xeroTrackingCategoryId: null,
      },
      select: { id: true, organizationId: true, name: true },
    })

    if (targets.length === 0) {
      console.log("No XeroProject rows to backfill — nothing to do.")
      return
    }

    const orgIds = [...new Set(targets.map((t) => t.organizationId))]
    const connections = await prisma.xeroConnection.findMany({
      where: { organizationId: { in: orgIds } },
      select: { organizationId: true, xeroTrackingCategoryId: true },
    })
    const activeCategoryByOrg = new Map(
      connections
        .filter((c) => c.xeroTrackingCategoryId)
        .map((c) => [c.organizationId, c.xeroTrackingCategoryId as string]),
    )

    let updated = 0
    let skipped = 0
    for (const row of targets) {
      const activeCategory = activeCategoryByOrg.get(row.organizationId)
      if (!activeCategory) {
        // Org has no active tracking category right now → can't infer
        // which category these rows came from. Leave NULL so the
        // listing query falls back to "show everything" (the no-category
        // branch). They'll be stamped on the first sync after the
        // admin picks a category.
        skipped++
        continue
      }
      await prisma.xeroProject.update({
        where: { id: row.id },
        data: { xeroTrackingCategoryId: activeCategory },
      })
      updated++
    }

    console.log(`Stamped ${updated} XeroProject rows.`)
    if (skipped > 0) {
      console.log(
        `Skipped ${skipped} rows (their org has no active tracking category — will get stamped on next sync).`,
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
