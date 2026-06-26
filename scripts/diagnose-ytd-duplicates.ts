import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * diagnose-ytd-duplicates.ts
 *
 * Prints, for every employee in the org, the count of SUBMITTED
 * payslips per (year, month). If any (employee, year, month) tuple
 * has > 1 payslip, that's a duplicate and explains PCB YTD coming
 * out too high.
 *
 *   npx tsx scripts/diagnose-ytd-duplicates.ts --year=2026 --org=<orgId>
 *
 * Output sections:
 *   1. Run-level duplicates — (org, year, month) pairs with more
 *      than one PayrollRun. Should never happen given the unique
 *      constraint, but worth catching if MariaDB skipped enforcing it.
 *   2. Payslip-level duplicates — (employee, year, month) pairs with
 *      more than one payslip across all submitted runs. This is what
 *      drives YTD double-counting.
 *   3. Top-10 employees by total submitted payslips in the year —
 *      if anyone has more than 12, that's the smoking gun.
 *
 * Pass --fix to delete the duplicate IMPORTED payslips (keeps the
 * most recently created one per (employee, period)). Dry-run by
 * default. NEVER touches COMPUTED runs.
 */

const yearArg = process.argv.find((a) => a.startsWith("--year="))
const orgArg = process.argv.find((a) => a.startsWith("--org="))
const FIX = process.argv.includes("--fix")
const YEAR = yearArg ? Number(yearArg.slice("--year=".length)) : new Date().getFullYear()
const ONLY_ORG_ID = orgArg ? orgArg.slice("--org=".length) : null

async function main() {
  const config = getDatabaseConnectionConfig()
  if (!config) throw new Error("Missing DB config — copy .env.example to .env first.")
  const adapter = new PrismaMariaDb({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 3,
    ssl: config.ssl,
  })
  const prisma = new PrismaClient({ adapter })

  try {
    const orgs = await prisma.organization.findMany({
      where: ONLY_ORG_ID ? { id: ONLY_ORG_ID } : undefined,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    })
    if (orgs.length === 0) {
      console.log("No organisations matched.")
      return
    }

    for (const org of orgs) {
      console.log(`\n══ ${org.name} (${org.id}) — ${YEAR} ══════════════════`)

      // ── 1. Run-level duplicates ──────────────────────────────────────
      const runs = await prisma.payrollRun.findMany({
        where: { organizationId: org.id, periodYear: YEAR },
        select: {
          id: true,
          periodMonth: true,
          source: true,
          status: true,
          createdAt: true,
        },
        orderBy: [{ periodMonth: "asc" }, { createdAt: "asc" }],
      })
      const runByMonth = new Map<number, typeof runs>()
      for (const r of runs) {
        const list = runByMonth.get(r.periodMonth) ?? []
        list.push(r)
        runByMonth.set(r.periodMonth, list)
      }
      let runDupCount = 0
      for (const [month, list] of runByMonth) {
        if (list.length > 1) {
          runDupCount += 1
          console.log(
            `  ⚠ month ${month} has ${list.length} runs:`,
            list.map((r) => `${r.source}/${r.status}@${r.createdAt.toISOString()}`).join(", "),
          )
        }
      }
      if (runDupCount === 0) {
        console.log(`  ✓ no run-level duplicates (${runByMonth.size} months populated)`)
      }

      // ── 2. Payslip-level duplicates per (employee, month) ─────────
      const payslips = await prisma.payslip.findMany({
        where: {
          payrollRun: {
            organizationId: org.id,
            periodYear: YEAR,
            status: "SUBMITTED",
          },
        },
        select: {
          id: true,
          employeeProfileId: true,
          snapshotName: true,
          snapshotEmployeeId: true,
          grossPay: true,
          payrollRunId: true,
          payrollRun: {
            select: {
              periodMonth: true,
              source: true,
            },
          },
        },
      })

      type Key = string
      const tupleKey = (empId: string, month: number): Key => `${empId}::${month}`
      const byTuple = new Map<Key, typeof payslips>()
      for (const p of payslips) {
        const key = tupleKey(p.employeeProfileId, p.payrollRun.periodMonth)
        const list = byTuple.get(key) ?? []
        list.push(p)
        byTuple.set(key, list)
      }
      type DuplicateGroup = {
        empId: string
        empName: string
        empCode: string
        month: number
        rows: typeof payslips
      }
      const dupGroups: DuplicateGroup[] = []
      for (const [, list] of byTuple) {
        if (list.length > 1) {
          dupGroups.push({
            empId: list[0].employeeProfileId,
            empName: list[0].snapshotName,
            empCode: list[0].snapshotEmployeeId,
            month: list[0].payrollRun.periodMonth,
            rows: list,
          })
        }
      }
      if (dupGroups.length === 0) {
        console.log(`  ✓ no (employee, month) duplicates — ${payslips.length} submitted payslips total`)
      } else {
        console.log(`  ⚠ ${dupGroups.length} (employee, month) tuple(s) have multiple payslips:`)
        for (const g of dupGroups.slice(0, 20)) {
          const sources = g.rows.map((r) => r.payrollRun.source).join(", ")
          console.log(
            `    - ${g.empCode} ${g.empName} · month ${g.month} · ${g.rows.length} payslips · sources [${sources}]`,
          )
        }
        if (dupGroups.length > 20) {
          console.log(`    … and ${dupGroups.length - 20} more`)
        }
      }

      // ── 3. Top-10 by total submitted payslips ─────────────────────
      const byEmployee = new Map<string, { name: string; code: string; count: number }>()
      for (const p of payslips) {
        const existing = byEmployee.get(p.employeeProfileId)
        if (existing) existing.count += 1
        else
          byEmployee.set(p.employeeProfileId, {
            name: p.snapshotName,
            code: p.snapshotEmployeeId,
            count: 1,
          })
      }
      const top = Array.from(byEmployee.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
      console.log(`  Top 10 by payslip count this year (≤12 is healthy):`)
      for (const t of top) {
        const flag = t.count > 12 ? " ⚠" : ""
        console.log(`    ${t.count.toString().padStart(3)} · ${t.code} ${t.name}${flag}`)
      }

      // ── 4. Optional cleanup ───────────────────────────────────────
      if (FIX && dupGroups.length > 0) {
        console.log(`\n  Applying --fix: removing extra payslips from IMPORTED runs only…`)
        let deleted = 0
        for (const g of dupGroups) {
          // Keep the row whose run is COMPUTED if present (engine-generated
          // truth wins); otherwise keep the most recently created import.
          const computed = g.rows.find((r) => r.payrollRun.source === "COMPUTED")
          const keepRow = computed ?? g.rows.slice().sort((a, b) => b.id.localeCompare(a.id))[0]
          const toDelete = g.rows.filter((r) => r.id !== keepRow.id && r.payrollRun.source === "IMPORTED")
          if (toDelete.length === 0) continue
          await prisma.payslip.deleteMany({
            where: { id: { in: toDelete.map((r) => r.id) } },
          })
          deleted += toDelete.length
        }
        console.log(`  ✓ Deleted ${deleted} duplicate payslip(s).`)
      } else if (dupGroups.length > 0 && !FIX) {
        console.log(`\n  Re-run with --fix to delete the duplicate IMPORTED payslips.`)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
