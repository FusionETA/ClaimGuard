import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { Prisma, PrismaClient } from "../generated/prisma/client"

/**
 * One-off backfill for the labelled multi-geolocation feature (Phase 1).
 *
 * Two migrations, both idempotent — safe to re-run at any time (during
 * a phased rollout, on migrations to new environments, etc.):
 *
 *   1) For each XeroProject that has BOTH `latitude` and `longitude`
 *      populated but no `ProjectGeoLocation` rows yet, insert a single
 *      "Main" location with those coordinates. Projects that already
 *      have any geoLocations row are left alone (an admin may have
 *      already curated the list post-Phase 3).
 *
 *   2) For each XeroProject that has a non-empty legacy `allowedIps`
 *      string AND a null `allowedIpsList` JSON column, split the
 *      string into labelled entries (`IP 1`, `IP 2`, ...) and write
 *      them to the new JSON column. The legacy column is nulled at
 *      the same time so there's a single source of truth going
 *      forward — the reader still falls back to the legacy column
 *      until it's dropped in a follow-up migration, so pre-migration
 *      rows stay readable if this script hasn't run yet.
 *
 * Usage:
 *   npm run db:backfill-project-geolocations
 * or:
 *   npx tsx prisma/backfill-project-geolocations.ts
 */

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
    // ── 1) Seed a "Main" ProjectGeoLocation per project with lat/long ──
    const projectsWithCoords = await prisma.xeroProject.findMany({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        geoLocations: { select: { id: true }, take: 1 },
      },
    })

    console.log(
      `[backfill-project-geolocations] scanning ${projectsWithCoords.length} projects with coordinates`,
    )

    let locationsCreated = 0
    let locationsSkipped = 0
    for (const project of projectsWithCoords) {
      if (project.geoLocations.length > 0) {
        locationsSkipped += 1
        continue
      }
      // Defensive: the where clause already filters nulls but Prisma
      // still types these as `number | null`. Skip if either is null.
      if (project.latitude == null || project.longitude == null) {
        locationsSkipped += 1
        continue
      }
      await prisma.projectGeoLocation.create({
        data: {
          projectId: project.id,
          label: "Main",
          latitude: project.latitude,
          longitude: project.longitude,
        },
      })
      locationsCreated += 1
      console.log(`  + ${project.name}: Main (${project.latitude}, ${project.longitude})`)
    }

    // ── 2) Migrate legacy `allowedIps` string → labelled JSON ──
    const projectsWithLegacyIps = await prisma.xeroProject.findMany({
      where: {
        allowedIps: { not: null },
        // Only projects that haven't been migrated yet: `allowedIpsList`
        // is null. If it's already populated (or an admin cleared it to
        // `[]` manually), skip.
        allowedIpsList: { equals: Prisma.JsonNull },
      },
      select: { id: true, name: true, allowedIps: true },
    })

    console.log(
      `[backfill-project-geolocations] scanning ${projectsWithLegacyIps.length} projects with legacy allowedIps`,
    )

    let allowlistsMigrated = 0
    let allowlistsSkipped = 0
    for (const project of projectsWithLegacyIps) {
      const raw = project.allowedIps ?? ""
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (parts.length === 0) {
        // Legacy string was "" or whitespace-only. Null the column so
        // it drops out of the "needs migration" query on re-run.
        await prisma.xeroProject.update({
          where: { id: project.id },
          data: { allowedIps: null },
        })
        allowlistsSkipped += 1
        continue
      }
      const labelled = parts.map((cidr, i) => ({ label: `IP ${i + 1}`, cidr }))
      await prisma.xeroProject.update({
        where: { id: project.id },
        data: {
          allowedIpsList: labelled as unknown as Prisma.InputJsonValue,
          allowedIps: null,
        },
      })
      allowlistsMigrated += 1
      console.log(`  ↻ ${project.name}: migrated ${labelled.length} allowlist entries`)
    }

    console.log("")
    console.log(`[backfill-project-geolocations] done.`)
    console.log(`  Geolocations created:    ${locationsCreated}`)
    console.log(`  Geolocations skipped:    ${locationsSkipped}`)
    console.log(`  Allowlists migrated:     ${allowlistsMigrated}`)
    console.log(`  Allowlists empty/nulled: ${allowlistsSkipped}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error("[backfill-project-geolocations] failed", err)
  process.exit(1)
})
