import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * backfill-org-addons.ts
 *
 * One-off: for every Organization, infer the `addons` array from the
 * data that actually exists in the DB and merge it into the org's
 * current addons (without removing anything already set).
 *
 *   - has at least one Claim                → "expense_claim"
 *   - has at least one AttendanceRecord     → "clock"
 *
 * AttendanceRecord has no `organizationId` column — we join via
 * `User.organizationId` since `AttendanceRecord.employeeId` → User.
 *
 * Why this exists: the partner API now provisions new orgs with an
 * explicit `addons` array, and the layout shells gate the Claims /
 * Attendance nav on that array. Legacy orgs (and orgs created before
 * the addon split) were left with addons = null / [], so their
 * existing claims + attendance data still lives in the DB but the
 * UI hides it. This script reverses that for any org with real
 * usage on those features.
 *
 * Usage:
 *
 *   npm run db:backfill-org-addons              # dry-run (no writes)
 *   npm run db:backfill-org-addons -- --apply   # commit the changes
 *
 *   # Limit to a single org by id (useful for spot-fixing).
 *   npm run db:backfill-org-addons -- --org=clxxxxxxxxxxxxxxxx
 *   npm run db:backfill-org-addons -- --apply --org=clxxxxxxxxxxxxxxxx
 *
 * Notes:
 *   - Existing addon strings are preserved (set union, no removals).
 *   - Plan + tier are NEVER touched. Orgs on DIY+FREE get flagged
 *     with `⚠ DIY+FREE` in the output because the layout shells
 *     ignore addons at that tier — bump them to DIY+PAID or EXPERT
 *     manually if you need the modules to show.
 *   - Safe to re-run. The merge is idempotent.
 */

const APPLY = process.argv.includes("--apply")
const orgArg = process.argv.find((a) => a.startsWith("--org="))
const ONLY_ORG_ID = orgArg ? orgArg.slice("--org=".length) : null

const VALID_ADDONS = new Set(["expense_claim", "clock"])

function normaliseAddons(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set()
  const out = new Set<string>()
  for (const v of raw) {
    if (typeof v !== "string") continue
    const lower = v.trim().toLowerCase()
    if (VALID_ADDONS.has(lower)) out.add(lower)
  }
  return out
}

function formatList(list: string[]): string {
  return list.length === 0 ? "[]" : `[${list.join(", ")}]`
}

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
    const orgs = await prisma.organization.findMany({
      where: ONLY_ORG_ID ? { id: ONLY_ORG_ID } : undefined,
      select: {
        id: true,
        name: true,
        plan: true,
        tier: true,
        addons: true,
      },
      orderBy: { name: "asc" },
    })

    if (orgs.length === 0) {
      console.log("No organizations matched.")
      return
    }

    const orgIds = orgs.map((o) => o.id)

    // One query per signal — cheaper than per-org loops. groupBy
    // counts the rows per org so we know who has data and who doesn't.
    const [claimGroups, attendanceRows] = await Promise.all([
      prisma.claim.groupBy({
        by: ["organizationId"],
        where: { organizationId: { in: orgIds } },
        _count: { _all: true },
      }),
      // AttendanceRecord has no organizationId — join via User.
      // `distinct: ["employeeId"]` keeps the read cheap on busy orgs.
      prisma.attendanceRecord.findMany({
        where: { employee: { organizationId: { in: orgIds } } },
        select: { employee: { select: { organizationId: true } } },
        distinct: ["employeeId"],
      }),
    ])

    const claimsByOrg = new Map<string, number>()
    for (const row of claimGroups) {
      if (row.organizationId)
        claimsByOrg.set(row.organizationId, row._count._all)
    }

    const attendanceByOrg = new Map<string, number>()
    for (const row of attendanceRows) {
      const id = row.employee?.organizationId
      if (!id) continue
      attendanceByOrg.set(id, (attendanceByOrg.get(id) ?? 0) + 1)
    }

    type Update = {
      id: string
      name: string
      plan: string | null
      tier: string | null
      before: string[]
      after: string[]
      added: string[]
    }
    const updates: Update[] = []

    for (const org of orgs) {
      const before = normaliseAddons(org.addons)
      const after = new Set(before)
      if ((claimsByOrg.get(org.id) ?? 0) > 0) after.add("expense_claim")
      if ((attendanceByOrg.get(org.id) ?? 0) > 0) after.add("clock")

      const added = [...after].filter((a) => !before.has(a))
      if (added.length === 0) continue
      updates.push({
        id: org.id,
        name: org.name,
        plan: org.plan,
        tier: org.tier,
        before: [...before],
        after: [...after],
        added,
      })
    }

    if (updates.length === 0) {
      console.log(
        `Scanned ${orgs.length} organizations. Nothing to backfill — every org's addons already match its data.`,
      )
      return
    }

    console.log(
      `\n${APPLY ? "APPLYING" : "DRY RUN"} — ${updates.length} of ${orgs.length} organizations need addon backfill:\n`,
    )

    const namePad = Math.max(...updates.map((u) => u.name.length), 12)
    const header = [
      "Organization".padEnd(namePad),
      "Plan".padEnd(7),
      "Tier".padEnd(6),
      "Before".padEnd(32),
      "After".padEnd(32),
      "Added",
    ].join("  ")
    console.log(header)
    console.log("-".repeat(header.length))

    for (const u of updates) {
      const planWarning =
        u.plan === "DIY" && u.tier === "FREE"
          ? " ⚠ DIY+FREE (addons ignored)"
          : ""
      console.log(
        [
          u.name.padEnd(namePad),
          (u.plan ?? "—").padEnd(7),
          (u.tier ?? "—").padEnd(6),
          formatList(u.before).padEnd(32),
          formatList(u.after).padEnd(32),
          u.added.join(", ") + planWarning,
        ].join("  "),
      )
    }

    if (!APPLY) {
      console.log(
        `\nDry run complete. Re-run with --apply to perform the updates.`,
      )
      return
    }

    // Single transaction so a partial run doesn't leave the DB in a
    // half-updated state. Each write is a single-row update keyed by
    // primary key — fast even with hundreds of orgs.
    const result = await prisma.$transaction(
      updates.map((u) =>
        prisma.organization.update({
          where: { id: u.id },
          data: { addons: u.after },
        }),
      ),
    )
    console.log(`\n✓ Updated ${result.length} organizations.`)

    const stuck = updates.filter(
      (u) => u.plan === "DIY" && u.tier === "FREE",
    )
    if (stuck.length > 0) {
      console.log(
        `\n⚠ ${stuck.length} of those are on DIY+FREE. Addons are IGNORED at that tier, so the modules will still be hidden in the nav. Bump them to DIY+PAID or EXPERT manually if you want the modules to show:`,
      )
      for (const u of stuck) console.log(`    - ${u.name} (${u.id})`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
