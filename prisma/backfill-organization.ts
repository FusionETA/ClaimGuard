import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

const DEFAULT_ORGANIZATION_NAME = "Globe Engineering"
const DEFAULT_CLAIM_CUTOFF_DAY = 25

function getOrganizationNameFromArgs() {
  const value = process.argv[2]?.trim()
  return value && value.length > 0 ? value : DEFAULT_ORGANIZATION_NAME
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
  const organizationName = getOrganizationNameFromArgs()

  try {
    const organization = await prisma.organization.upsert({
      where: { name: organizationName },
      update: {},
      create: {
        name: organizationName,
        claimCutoffDay: DEFAULT_CLAIM_CUTOFF_DAY,
      },
    })

    const usersBackfilled = await prisma.user.updateMany({
      where: { organizationId: null },
      data: { organizationId: organization.id },
    })

    const claimsBackfilled = await prisma.claim.updateMany({
      where: { organizationId: null },
      data: { organizationId: organization.id },
    })

    console.log(`Organization ready: ${organization.name} (${organization.id})`)
    console.log(`Users assigned: ${usersBackfilled.count}`)
    console.log(`Claims assigned: ${claimsBackfilled.count}`)
    console.log("Backfill complete. You can now keep this nullable rollout, or tighten the field later.")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
