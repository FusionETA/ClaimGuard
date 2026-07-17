import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * set-child-relief-full-for-org.ts
 *
 * One-off: for every PayrollProfile in a given organisation, flip
 * every child's `pcbDeduction` in `childRelief` to `"FULL"` (100%
 * claimed by this employee, vs the default `"NONE"` / `"HALF"` split
 * with spouse). Lowers PCB withholding by pushing every qualifying
 * child into the max relief bucket.
 *
 * Only rewrites children currently set to something other than FULL —
 * safe to re-run (idempotent).
 *
 * Only touches PayrollProfiles that already have `childRelief`
 * populated. Does NOT invent children for employees with no children
 * on file.
 *
 * Usage:
 *
 *   # Dry-run against the default org name (contains "ZR-Test")
 *   npm run db:set-child-relief-full
 *
 *   # Commit the changes
 *   npm run db:set-child-relief-full -- --apply
 *
 *   # Target a different org by name substring
 *   npm run db:set-child-relief-full -- --org="ABM"
 *   npm run db:set-child-relief-full -- --apply --org="ABM"
 */

const ORG_NAME_ARG = process.argv.find((a) => a.startsWith("--org="))
const ORG_ID_ARG = process.argv.find((a) => a.startsWith("--org-id="))
const ORG_NAME = ORG_NAME_ARG ? ORG_NAME_ARG.slice("--org=".length) : "ZR-Test"
const ORG_ID = ORG_ID_ARG ? ORG_ID_ARG.slice("--org-id=".length) : null
const APPLY = process.argv.includes("--apply")

type ChildEntry = {
  abilityStatus?: string
  currentlyStudying?: string
  pcbDeduction?: string
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
    // Prefer explicit --org-id when supplied (unambiguous). Otherwise
    // case-insensitive substring match on org name — matches "ZR-Test",
    // "ZR TEST", "zr test" etc. If multiple names match, refuse and
    // list them so we don't accidentally rewrite the wrong tenant.
    let org: { id: string; name: string } | null = null
    if (ORG_ID) {
      org = await prisma.organization.findUnique({
        where: { id: ORG_ID },
        select: { id: true, name: true },
      })
      if (!org) {
        console.error(`No org with id "${ORG_ID}".`)
        process.exit(1)
      }
    } else {
      const orgs = await prisma.organization.findMany({
        where: { name: { contains: ORG_NAME } },
        select: { id: true, name: true },
      })
      if (orgs.length === 0) {
        console.error(
          `No org matching "${ORG_NAME}". Try --org="<substring>" or --org-id=<id>.`,
        )
        process.exit(1)
      }
      if (orgs.length > 1) {
        console.error(
          `Ambiguous org name "${ORG_NAME}" — matched ${orgs.length}:\n` +
            orgs.map((o) => `  - ${o.name} (${o.id})`).join("\n") +
            `\nRe-run with a more specific --org= substring, or use --org-id=<id> to pick one.`,
        )
        process.exit(1)
      }
      org = orgs[0]!
    }
    console.log(`Org: ${org.name} (${org.id})`)
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`)
    console.log()

    // Pull every PayrollProfile in the org via its EmployeeProfile.
    // Include the user name for readable output.
    const profiles = await prisma.payrollProfile.findMany({
      where: {
        employeeProfile: { organizationId: org.id },
      },
      select: {
        id: true,
        childRelief: true,
        employeeProfile: {
          select: {
            user: { select: { name: true, email: true } },
          },
        },
      },
    })
    console.log(`Scanning ${profiles.length} payroll profile(s)…\n`)

    let profilesChanged = 0
    let childrenChanged = 0
    let profilesSkippedNoChildren = 0
    let profilesAlreadyFull = 0

    for (const p of profiles) {
      const raw = p.childRelief
      if (!Array.isArray(raw)) {
        profilesSkippedNoChildren += 1
        continue
      }
      const children = raw as ChildEntry[]
      if (children.length === 0) {
        profilesSkippedNoChildren += 1
        continue
      }

      const beforeShares = children.map((c) => c?.pcbDeduction ?? "?")
      const updated = children.map((c) => {
        if (!c || typeof c !== "object") return c
        if (c.pcbDeduction === "FULL") return c
        childrenChanged += 1
        return { ...c, pcbDeduction: "FULL" }
      })
      const afterShares = updated.map((c) => c?.pcbDeduction ?? "?")
      const beforeStr = beforeShares.join(",")
      const afterStr = afterShares.join(",")

      if (beforeStr === afterStr) {
        profilesAlreadyFull += 1
        continue
      }

      profilesChanged += 1
      const name = p.employeeProfile.user.name
      console.log(
        `  ${name.padEnd(45)} [${beforeStr}] → [${afterStr}]  (${children.length} child${children.length === 1 ? "" : "ren"})`,
      )

      if (APPLY) {
        await prisma.payrollProfile.update({
          where: { id: p.id },
          data: { childRelief: updated as unknown as object },
        })
      }
    }

    console.log()
    console.log(`--- Summary ---`)
    console.log(`  Profiles scanned: ${profiles.length}`)
    console.log(
      `  Profiles with children but nothing to change: ${profilesAlreadyFull}`,
    )
    console.log(
      `  Profiles with NO children on file (skipped): ${profilesSkippedNoChildren}`,
    )
    console.log(`  Profiles ${APPLY ? "updated" : "TO update"}: ${profilesChanged}`)
    console.log(`  Children ${APPLY ? "flipped" : "TO flip"}: ${childrenChanged}`)
    if (!APPLY && profilesChanged > 0) {
      console.log()
      console.log(
        `Dry-run — re-run with --apply to commit. Command:\n  npm run db:set-child-relief-full -- --apply${ORG_NAME_ARG ? ` --org="${ORG_NAME}"` : ""}`,
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
