import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * Backfill: for every Organization, create two seeded EmployeePolicy rows
 * that mirror the legacy hardcoded "Hourly Worker" / "Monthly Worker"
 * pair (previously labelled "Office Worker"), then assign unassigned
 * EmployeeProfile rows to the default hourly policy. Newer schemas store
 * salary/OT behavior on EmployeePolicy, not duplicated EmployeeProfile
 * payout columns.
 *
 * Idempotent: re-running will not duplicate policies (matched by
 * organizationId+name) and skips profiles already assigned to a policy.
 *
 * Re-running this script against an org that already has the legacy
 * "Office Worker" policy will create a SECOND policy named
 * "Monthly Worker"; the old one stays untouched (no admin data lost).
 * Admins can archive the duplicate from Settings → Policies if they
 * don't want it.
 *
 * Run AFTER `prisma db push` so the new columns/table exist.
 */

const HOURLY_NAME = "Hourly Worker"
const MONTHLY_NAME = "Monthly Worker"

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
    ssl: config.ssl,
    connectionLimit: 5,
  })
  const prisma = new PrismaClient({ adapter })

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      name: true,
    },
  })
  console.log(`Found ${orgs.length} organization(s).`)

  for (const org of orgs) {
    const hourly = await prisma.employeePolicy.upsert({
      where: { organizationId_name: { organizationId: org.id, name: HOURLY_NAME } },
      update: {},
      create: {
        organizationId: org.id,
        name: HOURLY_NAME,
        description: "Default policy for hourly-paid field workers. Selfie required at clock-in. OT paid out as cash.",
        isDefault: true,
        canAccessAttendance: true,
        canAccessClaims: true,
        canAccessLeave: true,
        salaryType: "HOURLY",
        otEnabled: true,
        requireGeofence: true,
        requireSelfie: true,
        otMethod: "CASH",
      },
    })

    await prisma.employeePolicy.upsert({
      where: { organizationId_name: { organizationId: org.id, name: MONTHLY_NAME } },
      update: {},
      create: {
        organizationId: org.id,
        name: MONTHLY_NAME,
        description: "Default policy for monthly-salaried staff. OT accrues to the time-balance bank.",
        isDefault: false,
        canAccessAttendance: true,
        canAccessClaims: true,
        canAccessLeave: true,
        salaryType: "MONTHLY_BASED",
        otEnabled: true,
        requireGeofence: true,
        requireSelfie: false,
        otMethod: "TIME_BANK",
      },
    })

    // Assign every unassigned profile in this org to the default seeded
    // policy. Existing assigned profiles are left untouched.
    const profiles = await prisma.employeeProfile.findMany({
      where: {
        policyId: null,
        user: { organizationId: org.id },
      },
      select: { id: true },
    })

    let hourlyCount = 0
    for (const profile of profiles) {
      await prisma.employeeProfile.update({
        where: { id: profile.id },
        data: { policyId: hourly.id },
      })
      hourlyCount++
    }

    console.log(
      `Org "${org.name}": seeded policies ✓ — assigned ${hourlyCount} profile(s) to ${HOURLY_NAME}.`,
    )
  }

  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
