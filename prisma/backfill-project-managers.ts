import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * One-shot backfill: copy each XeroProject.projectManagerId into the new
 * ProjectManager join table.
 *
 * Idempotent — uses upsert so re-running is safe. After this runs, all
 * code reads PMs via the join table; the legacy column becomes vestigial.
 */
async function main() {
  const config = getDatabaseConnectionConfig()
  if (!config) {
    throw new Error("Missing MySQL connection variables.")
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
    const projects = await prisma.xeroProject.findMany({
      where: { projectManagerId: { not: null } },
      select: { id: true, name: true, projectManagerId: true },
    })

    let copied = 0
    let skipped = 0
    for (const project of projects) {
      if (!project.projectManagerId) continue
      const existing = await prisma.projectManager.findUnique({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId: project.projectManagerId,
          },
        },
        select: { id: true },
      })
      if (existing) {
        skipped += 1
        continue
      }
      await prisma.projectManager.create({
        data: {
          projectId: project.id,
          userId: project.projectManagerId,
        },
      })
      copied += 1
      console.log(`  + ${project.name} → ${project.projectManagerId}`)
    }

    console.log("")
    console.log(`Backfill complete.`)
    console.log(`  Project managers copied: ${copied}`)
    console.log(`  Already in join table:   ${skipped}`)
    console.log(`  Total projects examined: ${projects.length}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
