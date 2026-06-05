/**
 * Issue a `wp_live_*` API token for an EXISTING organisation and print
 * the raw secret exactly once.
 *
 * Why this script exists: there is no admin-UI "create token" page wired
 * up yet, and the only other minting path
 * (`POST /api/v1/admin/organizations`) *creates a brand-new org* and
 * 409s if the name is taken — so it can't issue a token for an org you
 * already seeded with `create-org.ts`. This script fills that gap for
 * the smoke-test setup (and any other "I just need a token for org X"
 * case).
 *
 * Pair it with `create-org.ts`, which seeds the default Employee Policy
 * the employees smoke test needs:
 *
 *   npx tsx scripts/create-org.ts --org "Smoke Test Co" \
 *     --email smoke@fusioneta.com --name "Smoke Bot" --password 'Strong123!'
 *   npx tsx scripts/issue-api-token.ts --org "Smoke Test Co"
 *
 * Usage:
 *   npx tsx scripts/issue-api-token.ts --org "Smoke Test Co"
 *   npx tsx scripts/issue-api-token.ts --org "Smoke Test Co" --label "smoke" --all
 *   npx tsx scripts/issue-api-token.ts --org "Smoke Test Co" --scopes "claims:read,settings:read"
 *
 * Flags:
 *   --org     (required) organisation NAME (must already exist)
 *   --label   token label shown in audits/listings (default "smoke")
 *   --all     grant every scope in the catalog (overrides --scopes)
 *   --scopes  comma-separated scope list (default: the smoke-suite set)
 *
 * Token shape mirrors `lib/api-auth.ts` exactly (wp_live_<48 hex>, SHA-256
 * hash stored, raw shown once). Inlined here rather than imported because
 * `lib/api-auth.ts` is `import "server-only"` and can't load in a plain
 * tsx script — keep the two in sync if the format ever changes.
 */
import "dotenv/config"

import { createHash, randomBytes } from "node:crypto"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { API_SCOPE_CATALOG, isKnownApiScope } from "../lib/api-scopes"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/** The exact scope set the smoke suite needs (see tests/smoke/README.md). */
const SMOKE_SCOPES = [
  "employees:read",
  "employees:write",
  "projects:read",
  "projects:write",
  "teams:read",
  "teams:write",
  "claims:read",
  "claims:write",
  "chart-of-accounts:read",
  "policies:read",
  "payroll:read",
  "settings:read",
]

function parseArgs(): {
  orgName: string
  label: string
  all: boolean
  scopes: string[]
} {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`))
    if (i === -1) return undefined
    const eq = argv[i]?.indexOf("=") ?? -1
    if (eq >= 0) return argv[i]!.slice(eq + 1)
    return argv[i + 1]
  }
  const has = (flag: string): boolean => argv.includes(flag)

  const orgName = get("--org")
  if (!orgName) {
    console.error('Missing --org "<organisation name>".')
    process.exit(1)
  }

  const scopesRaw = get("--scopes")
  const scopes = scopesRaw
    ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : SMOKE_SCOPES

  return {
    orgName,
    label: get("--label") ?? "smoke",
    all: has("--all"),
    scopes,
  }
}

/** Mirror of `generateApiToken()` in lib/api-auth.ts. */
function generateApiToken(): { raw: string; hash: string; prefix: string } {
  const secret = randomBytes(24).toString("hex")
  const raw = `wp_live_${secret}`
  const hash = createHash("sha256").update(raw).digest("hex")
  return { raw, hash, prefix: raw.slice(0, 12) }
}

async function main() {
  const args = parseArgs()

  // Resolve the scope set and reject anything not in the catalog so a
  // typo doesn't silently produce a token that can't reach any resource.
  const requested = args.all ? [...API_SCOPE_CATALOG] : args.scopes
  const unknown = requested.filter((s) => !isKnownApiScope(s))
  if (unknown.length > 0) {
    console.error(`Unknown scope(s): ${unknown.join(", ")}`)
    console.error(`Valid scopes:\n  ${API_SCOPE_CATALOG.join("\n  ")}`)
    process.exit(1)
  }
  // Canonical order (matches the catalog) so two tokens diff cleanly.
  const scopes = API_SCOPE_CATALOG.filter((s) => requested.includes(s))

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
    const org = await prisma.organization.findUnique({
      where: { name: args.orgName },
      select: { id: true, name: true },
    })
    if (!org) {
      console.error(
        `No organisation named "${args.orgName}". Run create-org.ts first:\n` +
          `  npx tsx scripts/create-org.ts --org "${args.orgName}" --email owner@test.com --name "Owner" --password 'Strong123!'`,
      )
      process.exit(1)
    }

    const token = generateApiToken()
    const integration = await prisma.apiIntegration.create({
      data: {
        organizationId: org.id,
        name: args.label.trim() || "smoke",
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        // Prisma column is Json; a string[] serialises directly.
        scopes,
      },
      select: { id: true },
    })

    console.log("")
    console.log(`Org:            ${org.id} — ${org.name}`)
    console.log(`Token label:    ${args.label}`)
    console.log(`Integration id: ${integration.id}`)
    console.log(`Scopes (${scopes.length}):     ${scopes.join(", ")}`)
    console.log("")
    console.log("  ┌─────────────────────────────────────────────────────────┐")
    console.log("  │  RAW TOKEN — shown ONCE, copy it now (only the hash is    │")
    console.log("  │  stored). Put it in the GitHub secret SMOKE_API_TOKEN_DEV │")
    console.log("  │  (or _PROD).                                              │")
    console.log("  └─────────────────────────────────────────────────────────┘")
    console.log("")
    console.log(`  ${token.raw}`)
    console.log("")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
