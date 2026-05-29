/**
 * One-off: create a test admin + org, link them via AdminOrganization,
 * and seed the standard defaults (2 policies + 1 project + 1 team).
 *
 * Idempotent: if the org/admin already exist, the script skips creation
 * and just backfills any missing defaults.
 *
 * Edit the constants below before running.
 *
 *   npx tsx scripts/create-test-admin-org.ts
 */
import "dotenv/config"

import IORedis from "ioredis"
import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { hashPassword } from "../lib/auth/password"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

const ADMIN_EMAIL = "test@fusioneta.com"
const ADMIN_NAME = "Test Admin"
const ADMIN_PASSWORD = "Test12345!"
const ORG_NAME = "TestCo"

/**
 * Mirror of `organizationRepository.seedDefaultsForNewOrganization` —
 * duplicated here because that file is `import "server-only"` and can't
 * be loaded from a plain tsx script. Keep in sync.
 *
 * Idempotent on every aggregate (count-checks before inserting).
 */
async function seedDefaults(
  prisma: PrismaClient,
  organizationId: string,
  organizationName: string,
): Promise<void> {
  const trimmedName = organizationName.trim() || "Organization"
  const otRates = {
    otRateNormalDay: 1.5,
    otRateRestDay: 2.0,
    otRatePublicHoliday: 3.0,
    otRateRestDayInShift: 1.0,
    otRatePublicHolidayInShift: 2.0,
    otSalaryThreshold: null,
    otDailyThresholdMinutes: 480,
  }
  const flags = {
    canAccessAttendance: true,
    canAccessClaims: true,
    canAccessLeave: true,
    otEnabled: true,
    otMethod: "CASH" as const,
    requireGeofence: true,
    requireSelfie: false,
    temporary: false,
  }

  const policyCount = await prisma.employeePolicy.count({
    where: { organizationId },
  })
  if (policyCount === 0) {
    // Monthly first → becomes the auto-default for this org.
    await prisma.employeePolicy.create({
      data: {
        organizationId,
        name: "Monthly Workers",
        salaryType: "MONTHLY_BASED",
        isDefault: true,
        ...flags,
        ...otRates,
      },
    })
    await prisma.employeePolicy.create({
      data: {
        organizationId,
        name: "Hourly Workers",
        salaryType: "HOURLY",
        isDefault: false,
        ...flags,
        ...otRates,
      },
    })
    console.log("  Policies:        Monthly Workers (default) + Hourly Workers")
  } else {
    console.log(`  Policies:        skipped (${policyCount} already exist)`)
  }

  let projectId: string | null = null
  const projectCount = await prisma.xeroProject.count({
    where: { organizationId },
  })
  if (projectCount === 0) {
    const project = await prisma.xeroProject.create({
      data: {
        organizationId,
        name: `${trimmedName} Project (default)`,
        archivedByXeroConnect: false,
      },
    })
    projectId = project.id
    console.log(`  Project:         ${project.name}`)
  } else {
    const first = await prisma.xeroProject.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    projectId = first?.id ?? null
    console.log(`  Project:         skipped (${projectCount} already exist)`)
  }

  if (projectId) {
    const teamCount = await prisma.team.count({
      where: { project: { organizationId } },
    })
    if (teamCount === 0) {
      await prisma.team.create({
        data: {
          projectId,
          name: `${trimmedName} Team (default)`,
          layerCount: 1,
          moduleConfig: {
            CLAIMS: [1],
            OT: [1],
            LEAVE: [1],
            ATTENDANCE: [1],
          },
        },
      })
      console.log(`  Team:            ${trimmedName} Team (default)`)
    } else {
      console.log(`  Team:            skipped (${teamCount} already exist)`)
    }
  }
}

async function main() {
  const config = getDatabaseConnectionConfig()
  if (!config) throw new Error("Missing MySQL connection variables.")
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

  try {
    // --- Org -----------------------------------------------------------
    let org = await prisma.organization.findUnique({
      where: { name: ORG_NAME },
      select: { id: true, name: true },
    })
    if (!org) {
      org = await prisma.organization.create({
        data: { name: ORG_NAME },
        select: { id: true, name: true },
      })
      console.log(`Org created:     ${org.id} — ${org.name}`)
    } else {
      console.log(`Org exists:      ${org.id} — ${org.name}`)
    }

    // --- Admin user ----------------------------------------------------
    let admin = await prisma.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true, email: true, organizationId: true },
    })
    if (!admin) {
      admin = await prisma.user.create({
        data: {
          name: ADMIN_NAME,
          email: ADMIN_EMAIL,
          passwordHash: hashPassword(ADMIN_PASSWORD),
          role: "ADMIN",
          organizationId: org.id,
        },
        select: { id: true, email: true, organizationId: true },
      })
      console.log(`Admin created:   ${admin.id} — ${admin.email}`)
    } else {
      console.log(`Admin exists:    ${admin.id} — ${admin.email}`)
      if (!admin.organizationId) {
        await prisma.user.update({
          where: { id: admin.id },
          data: { organizationId: org.id },
        })
        console.log(`  → set User.organizationId to ${org.id}`)
      }
    }

    // --- AdminOrganization link ---------------------------------------
    await prisma.adminOrganization.upsert({
      where: {
        adminId_organizationId: { adminId: admin.id, organizationId: org.id },
      },
      create: { adminId: admin.id, organizationId: org.id },
      update: {},
    })
    console.log(`AdminOrg link:   ✓`)

    // --- Defaults ------------------------------------------------------
    console.log("Seeding defaults:")
    await seedDefaults(prisma, org.id, org.name)

    // --- Bust Redis caches --------------------------------------------
    // The company-structure / hierarchy / settings pages cache for up
    // to 1 hour under `org:{orgId}:config:*`. Without busting, the
    // newly-seeded project + team don't appear until the TTL expires.
    await bustOrgConfigCaches(org.id)

    console.log("")
    console.log(`Login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`)
  } finally {
    await prisma.$disconnect()
  }
}

async function bustOrgConfigCaches(organizationId: string): Promise<void> {
  const url = process.env.REDIS_URL?.trim()
  if (!url) {
    console.log("Cache bust:      skipped (REDIS_URL unset)")
    return
  }
  const prefix = process.env.REDIS_KEY_PREFIX?.trim() || "altomatehr"
  const redis = new IORedis(url, { lazyConnect: true })
  try {
    await redis.connect()
    // Match the patterns in lib/cache-invalidation.ts → bustOrgConfigCaches.
    // KEYS is O(N) but fine for a one-off script.
    const patterns = [
      `${prefix}:org:${organizationId}:config:*`,
      `${prefix}:org:${organizationId}:user:*:config:*`,
    ]
    let totalDeleted = 0
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern)
      if (keys.length > 0) {
        await redis.del(...keys)
        totalDeleted += keys.length
      }
    }
    console.log(`Cache bust:      ✓ deleted ${totalDeleted} key(s)`)
  } finally {
    redis.disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
