import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * Backfill: grant the two new payroll scopes (`payroll:read` and
 * `payroll:write`) to every existing `ApiIntegration` token.
 *
 * Context: the May 2026 release added 3 new external endpoints —
 * /api/v1/employees/active-count, /api/v1/payroll-runs (list + detail),
 * and /api/v1/payroll-runs/[id]/approve — guarded by the new payroll
 * scopes. Existing tokens were issued before those scopes existed, so
 * they can't call the new endpoints until an admin (or this script)
 * grants them.
 *
 * Idempotent — if a token already has both scopes, this script leaves
 * it untouched and doesn't bump any timestamps. Safe to re-run.
 *
 * Run:
 *   npx ts-node prisma/backfill-payroll-scopes.ts
 * or:
 *   npx tsx prisma/backfill-payroll-scopes.ts
 */

const SCOPES_TO_ADD = ["payroll:read", "payroll:write"] as const

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

  const tokens = await prisma.apiIntegration.findMany({
    select: { id: true, name: true, organizationId: true, scopes: true },
  })
  console.log(`Found ${tokens.length} ApiIntegration row(s).`)

  let updated = 0
  let skipped = 0
  for (const t of tokens) {
    const current = Array.isArray(t.scopes)
      ? (t.scopes as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : []
    const missing = SCOPES_TO_ADD.filter((s) => !current.includes(s))
    if (missing.length === 0) {
      skipped += 1
      continue
    }
    const next = Array.from(new Set([...current, ...missing]))
    await prisma.apiIntegration.update({
      where: { id: t.id },
      data: { scopes: next },
    })
    console.log(
      `+ ${t.name} (org ${t.organizationId}) — added: ${missing.join(", ")}`,
    )
    updated += 1
  }

  console.log(
    `\nDone. ${updated} token(s) updated, ${skipped} already had both scopes.`,
  )
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
