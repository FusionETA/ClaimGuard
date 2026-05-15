import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * Backfill: for every Organization, create two seeded EmployeePolicy rows
 * that mirror the legacy hardcoded "Hourly Worker" / "Office Worker"
 * behavior, then assign each EmployeeProfile to whichever policy matches
 * its existing payoutMethod + otPayoutMethod combination.
 *
 * Idempotent: re-running will not duplicate policies (matched by
 * organizationId+name) and skips profiles already assigned to a policy.
 *
 * Run AFTER `prisma db push` so the new columns/table exist.
 */

const HOURLY_NAME = "Hourly Worker"
const OFFICE_NAME = "Office Worker"

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
      // Legacy org-level OT rate fields. Once the schema is updated to
      // drop these columns this `select` will need to be removed; the
      // policy will already hold the values.
      otRateNormalDay: true,
      otRateRestDay: true,
      otRatePublicHoliday: true,
      restDayInShiftRate: true,
      publicHolidayInShiftRate: true,
      otSalaryThreshold: true,
      otDailyThresholdMinutes: true,
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

    const office = await prisma.employeePolicy.upsert({
      where: { organizationId_name: { organizationId: org.id, name: OFFICE_NAME } },
      update: {},
      create: {
        organizationId: org.id,
        name: OFFICE_NAME,
        description: "Default policy for monthly-salaried office staff. OT accrues to the time-balance bank.",
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

    // Assign every unassigned profile in this org to one of the two
    // seeded policies, based on its existing payoutMethod.
    const profiles = await prisma.employeeProfile.findMany({
      where: {
        policyId: null,
        user: { organizationId: org.id },
      },
      select: { id: true, payoutMethod: true, otPayoutMethod: true },
    })

    let hourlyCount = 0
    let officeCount = 0
    for (const profile of profiles) {
      const targetId =
        profile.payoutMethod === "MONTHLY_BASED" ? office.id : hourly.id
      await prisma.employeeProfile.update({
        where: { id: profile.id },
        data: { policyId: targetId },
      })
      if (targetId === hourly.id) hourlyCount++
      else officeCount++
    }

    // Copy the org's legacy OT rate values onto every policy in the
    // org. Run AFTER the seeded upserts so newly-created seeds also
    // inherit the org's existing rates instead of the Prisma defaults.
    // Safe to re-run — idempotent overwrite to the same values.
    const otUpdate = await prisma.employeePolicy.updateMany({
      where: { organizationId: org.id },
      data: {
        otRateNormalDay: org.otRateNormalDay,
        otRateRestDay: org.otRateRestDay,
        otRatePublicHoliday: org.otRatePublicHoliday,
        otRateRestDayInShift: org.restDayInShiftRate,
        otRatePublicHolidayInShift: org.publicHolidayInShiftRate,
        otSalaryThreshold: org.otSalaryThreshold,
        otDailyThresholdMinutes: org.otDailyThresholdMinutes,
      },
    })

    console.log(
      `Org "${org.name}": seeded policies ✓ — assigned ${hourlyCount} hourly, ${officeCount} office; copied OT rates onto ${otUpdate.count} policies.`,
    )
  }

  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
