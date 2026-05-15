/**
 * One-off script to create the FusionETA organization + two admin
 * users (NicholasTest, SimonTest), both with password "qwertyasd".
 *
 * Run with:
 *   DATABASE_URL="…" npx tsx create-fusioneta.ts
 *
 * Idempotent: re-running upserts on email/name, so safe to run twice.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { hashPassword } from "./lib/auth/password"
import { PrismaClient } from "./generated/prisma/client"

const url = new URL(process.env.DATABASE_URL!)
const adapter = new PrismaMariaDb({
  host: url.hostname,
  port: Number(url.port || "3306"),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
  connectionLimit: 5,
  ssl: { rejectUnauthorized: false },
})
const prisma = new PrismaClient({ adapter })

const ORG_NAME = "FusionETA"
const PASSWORD = "qwertyasd"
const ADMINS = [
  { email: "nicholastest@fusioneta.com", name: "NicholasTest" },
  { email: "simontest@fusioneta.com", name: "SimonTest" },
] as const

async function main() {
  // ── 1. Create / upsert the org ────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { name: ORG_NAME },
    update: {},
    create: { name: ORG_NAME },
  })
  console.log(`✓ Organization: ${org.name} (${org.id})`)

  // ── 2. Create / upsert the two admin users ──────────────────────────
  for (const admin of ADMINS) {
    const user = await prisma.user.upsert({
      where: { email: admin.email },
      update: {
        name: admin.name,
        role: "ADMIN",
        organizationId: org.id,
        passwordHash: hashPassword(PASSWORD),
      },
      create: {
        email: admin.email,
        name: admin.name,
        role: "ADMIN",
        organizationId: org.id,
        passwordHash: hashPassword(PASSWORD),
      },
    })
    console.log(`✓ Admin: ${user.name} <${user.email}> (${user.id})`)

    // Link the admin to the org via the AdminOrganization join table
    // (this is the canonical "user can admin this org" relation; the
    // direct user.organizationId is the "home org").
    await prisma.adminOrganization.upsert({
      where: {
        adminId_organizationId: {
          adminId: user.id,
          organizationId: org.id,
        },
      },
      update: {},
      create: { adminId: user.id, organizationId: org.id },
    })
    console.log(`  → linked as admin of ${org.name}`)
  }

  console.log("\nDone. Login credentials:")
  console.log(`  Organization : ${ORG_NAME}`)
  for (const a of ADMINS) {
    console.log(`  ${a.email}    password: ${PASSWORD}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
