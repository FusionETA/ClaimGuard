import "dotenv/config"

import { createHash, randomBytes } from "node:crypto"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * One-shot CLI for minting a `MasterApiKey` row.
 *
 * Usage:
 *   npm run db:create-master-key -- "Acme HR portal"
 *   npm run db:create-master-key -- "Acme HR portal" "Contract #1234, contact: ops@acme.com"
 *
 * Prints the raw `wp_master_*` secret to stdout exactly ONCE — capture
 * it now, store it in your partner's secret store. Only the SHA-256
 * hash is persisted; we cannot recover the secret if you lose it
 * (you'd need to mint a new one).
 *
 * The secret is duplicated into `lib/master-api-auth.ts`'s token
 * generator (same algorithm) on purpose: this script is meant to run
 * standalone (no `import "server-only"` deps) so it can execute under
 * tsx without pulling Next-runtime modules.
 */

function generateMasterApiKey() {
  const secret = randomBytes(32).toString("hex")
  const raw = `wp_master_${secret}`
  const hash = createHash("sha256").update(raw).digest("hex")
  return { raw, hash, prefix: raw.slice(0, 14) }
}

async function main() {
  const partnerName = process.argv[2]?.trim()
  const notes = process.argv[3]?.trim() || null

  if (!partnerName) {
    console.error(
      'Usage: npm run db:create-master-key -- "<Partner name>" ["Optional notes"]',
    )
    process.exit(1)
  }
  if (partnerName.length < 2) {
    console.error("Partner name must be at least 2 characters.")
    process.exit(1)
  }

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
    ssl: config.ssl,
  })
  const prisma = new PrismaClient({ adapter })

  try {
    const { raw, hash, prefix } = generateMasterApiKey()

    const row = await prisma.masterApiKey.create({
      data: {
        partnerName,
        tokenHash: hash,
        tokenPrefix: prefix,
        notes,
      },
      select: { id: true, createdAt: true },
    })

    const banner = "=".repeat(72)
    console.log("")
    console.log(banner)
    console.log("Master API key created.")
    console.log(banner)
    console.log(`Partner:   ${partnerName}`)
    if (notes) console.log(`Notes:     ${notes}`)
    console.log(`Key ID:    ${row.id}`)
    console.log(`Prefix:    ${prefix}`)
    console.log(`Created:   ${row.createdAt.toISOString()}`)
    console.log("")
    console.log("SECRET (shown ONCE — store now, this cannot be recovered):")
    console.log("")
    console.log(`  ${raw}`)
    console.log("")
    console.log("Hand this to the partner. They include it as:")
    console.log("  Authorization: Bearer <secret>")
    console.log("on calls to /api/v1/admin/* endpoints.")
    console.log(banner)
    console.log("")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error("Failed to create master key:", error)
  process.exit(1)
})
