/// One-off: seed default leave types for every org that is missing them.
/// Safe to run multiple times — existing leave types are never touched.
///
///   npx tsx scripts/backfill-leave-types.ts
import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

// Mirror of DEFAULT_LEAVE_TYPES in modules/leave/application/services/leave-defaults.service.ts
// Keep in sync if that list changes.
const DEFAULT_LEAVE_TYPES = [
  { code: "ANNUAL",          name: "Annual Leave",          paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 14, carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "MEDICAL",         name: "Medical Leave",         paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 14, carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "COMPASSIONATE",   name: "Compassionate Leave",   paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 3,  carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "HOSPITALIZATION", name: "Hospitalization Leave", paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 60, carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "MARRIAGE",        name: "Marriage Leave",        paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 3,  carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "MATERNITY",       name: "Maternity Leave",       paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 98, carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "PATERNITY",       name: "Paternity Leave",       paid: true,  accrualMethod: "LUMP_SUM" as const, defaultDays: 7,  carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
  { code: "UNPAID",          name: "Unpaid Leave",          paid: false, accrualMethod: "LUMP_SUM" as const, defaultDays: 0,  carryForward: false, carryExpiryMonth: null, maxCarryForwardDays: null },
]

async function main() {
  const cfg = getDatabaseConnectionConfig()
  if (!cfg) throw new Error("Missing database env — set DATABASE_URL or DATABASE_HOST etc.")

  const adapter = new PrismaMariaDb({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
    connectionLimit: 5,
  })
  const prisma = new PrismaClient({ adapter })

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } })
  console.log(`Found ${orgs.length} organization(s).`)

  let totalCreated = 0

  for (const org of orgs) {
    const existing = await prisma.leaveType.findMany({
      where: { organizationId: org.id },
      select: { code: true },
    })
    const existingCodes = new Set(existing.map((r) => r.code.toUpperCase()))
    const missing = DEFAULT_LEAVE_TYPES.filter((d) => !existingCodes.has(d.code))

    if (missing.length === 0) {
      console.log(`  [ok]   ${org.name}`)
      continue
    }

    await prisma.leaveType.createMany({
      data: missing.map((d) => ({ organizationId: org.id, ...d })),
      skipDuplicates: true,
    })
    console.log(`  [+${missing.length}]  ${org.name} — created: ${missing.map((d) => d.code).join(", ")}`)
    totalCreated += missing.length
  }

  console.log(`\nDone. ${totalCreated} leave type(s) seeded across ${orgs.length} org(s).`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
