/**
 * Create a new organisation + its OWNER user, link them via
 * AdminOrganization, and seed the standard defaults (2 employee
 * policies + 1 project + 1 team).
 *
 * The seed user is always OWNER — that's what a brand-new org's first
 * account should be. Subsequent ADMIN users belong to the in-app
 * Settings UI, not to this script.
 *
 * This is the canonical "give me a new org for testing" tool.
 * Idempotent: if the org/user already exist, the script skips
 * creation and just backfills any missing defaults.
 *
 * Usage:
 *   npx tsx scripts/create-org.ts \
 *     --org "Acme Inc" \
 *     --email owner@acme.test \
 *     --name "Acme Owner" \
 *     --password "Acme12345!"
 *
 * All flags optional; defaults below.
 *
 * Why this lives here rather than as a service call: the application
 * `organizationRepository` is `import "server-only"` and can't be
 * imported from a plain tsx script. The seeding block below MIRRORS
 * `organizationRepository.seedDefaultsForNewOrganization` — keep the
 * two in sync if defaults ever change.
 */
import "dotenv/config"

import IORedis from "ioredis"
import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { hashPassword } from "../lib/auth/password"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

// ---------- CLI args -------------------------------------------------

function parseArgs(): {
  orgName: string
  email: string
  name: string
  password: string
} {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`))
    if (i === -1) return undefined
    const eq = argv[i]?.indexOf("=") ?? -1
    if (eq >= 0) return argv[i]!.slice(eq + 1)
    return argv[i + 1]
  }
  return {
    orgName: get("--org") ?? "TestCo",
    email: get("--email") ?? "test@fusioneta.com",
    name: get("--name") ?? "Test Owner",
    password: get("--password") ?? "Test12345!",
  }
}

// ---------- Default seeding ------------------------------------------

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

// ---------- Redis cache bust -----------------------------------------

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
    // Mirror lib/cache-invalidation.ts → bustOrgConfigCaches patterns.
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

// ---------- Main -----------------------------------------------------

async function main() {
  const args = parseArgs()
  console.log(`Org:      ${args.orgName}`)
  console.log(`Owner:    ${args.name} <${args.email}>`)
  console.log("")

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
      where: { name: args.orgName },
      select: { id: true, name: true },
    })
    if (!org) {
      org = await prisma.organization.create({
        data: { name: args.orgName },
        select: { id: true, name: true },
      })
      console.log(`Org created:     ${org.id} — ${org.name}`)
    } else {
      console.log(`Org exists:      ${org.id} — ${org.name}`)
    }

    // --- Admin user ----------------------------------------------------
    // findFirst — email is no longer @unique on User (archived
    // employees can come back under the same address). The script
    // is idempotent: re-running with the same email reuses the
    // existing row.
    let admin = await prisma.user.findFirst({
      where: { email: args.email },
      select: { id: true, email: true, organizationId: true },
    })
    if (!admin) {
      admin = await prisma.user.create({
        data: {
          name: args.name,
          email: args.email,
          passwordHash: hashPassword(args.password),
          role: "OWNER",
          organizationId: org.id,
        },
        select: { id: true, email: true, organizationId: true },
      })
      console.log(`Owner created:   ${admin.id} — ${admin.email}`)
    } else {
      console.log(`User exists:     ${admin.id} — ${admin.email}`)
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
    // Without this, the company-structure / hierarchy / settings pages
    // serve their pre-seed cached payload for up to 1 hour. Only
    // matters when the org existed before (the cache lookup ran).
    await bustOrgConfigCaches(org.id)

    console.log("")
    console.log(`Login: ${args.email} / ${args.password}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
