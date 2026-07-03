import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

/**
 * One-off migration — reclassify existing "Other Deduction" line items
 * that were incorrectly categorized as `deduct_salary_adjustment` into
 * the new `deduct_miscellaneous` category (post-tax, does NOT reduce
 * gross or statutory bases). See the category docblock in
 * `modules/payroll/domain/models.ts` for the rationale.
 *
 * Two safeguards:
 *   1. DRY RUN by default. Pass `--apply` to actually write.
 *   2. Only touches:
 *      - `PayrollProfile.fixedAllowances` (JSON) — master template that
 *        gets applied on every future run.
 *      - `PayrollRunAdjustment.manualLineItems` (JSON) — per-run
 *        overrides — BUT only when the run's status is DRAFT. SUBMITTED
 *        runs are frozen compliance snapshots and never rewritten.
 *      Deliberately skips `PayslipLineItem` — those are baked into the
 *      Payslip's gross/net/PCB aggregates. Fixing the category alone
 *      wouldn't recompute the totals; the whole payslip would need to
 *      re-run through the calc engine. Safer to leave SUBMITTED
 *      payslips untouched and only pick up the fix from the next run.
 *
 * Match criteria:
 *   - `category === "deduct_salary_adjustment"`
 *   - `name` (or `label` in adjustments) matches the label the admin
 *     typed as "Other Deduction" (case-insensitive substring "other"
 *     + "deduc"). Tune the regex below if your data uses a different
 *     wording.
 *
 * Optional org scope:
 *   npm run tsx scripts/migrate-other-deduction-to-miscellaneous.ts -- \
 *     --organizationId=<orgId> [--apply]
 */

const OLD_CATEGORY = "deduct_salary_adjustment"
const NEW_CATEGORY = "deduct_miscellaneous"

// Case-insensitive: must include "other" AND "deduc". Common variants
// covered: "Other Deduction", "OTH. DEDUCTION", "other-deductions".
const LABEL_PATTERN = /other/i
const LABEL_PATTERN_2 = /deduc/i

function matchesLabel(label: unknown): boolean {
  if (typeof label !== "string") return false
  return LABEL_PATTERN.test(label) && LABEL_PATTERN_2.test(label)
}

function parseArgs(argv: string[]): {
  apply: boolean
  organizationId: string | null
} {
  const args = { apply: false, organizationId: null as string | null }
  for (const a of argv) {
    if (a === "--apply") args.apply = true
    else if (a.startsWith("--organizationId=")) {
      args.organizationId = a.slice("--organizationId=".length)
    }
  }
  return args
}

type LineItem = {
  category?: string
  name?: string
  label?: string
  kind?: string
  amount?: number
}

/** Returns a new JSON array with matching entries reclassified. */
function migrateItems(items: unknown): {
  changed: boolean
  changedCount: number
  next: unknown
  changedEntries: Array<{
    index: number
    label: string
    amount: number | null
  }>
} {
  if (!Array.isArray(items)) {
    return { changed: false, changedCount: 0, next: items, changedEntries: [] }
  }
  const changedEntries: Array<{
    index: number
    label: string
    amount: number | null
  }> = []
  let changed = false
  const next = items.map((item, idx) => {
    if (!item || typeof item !== "object") return item
    const it = item as LineItem
    if (it.category !== OLD_CATEGORY) return item
    const label = (it.name ?? it.label) as unknown
    if (!matchesLabel(label)) return item
    changed = true
    changedEntries.push({
      index: idx,
      label: typeof label === "string" ? label : "",
      amount: typeof it.amount === "number" ? it.amount : null,
    })
    return { ...it, category: NEW_CATEGORY }
  })
  return { changed, changedCount: changedEntries.length, next, changedEntries }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const modeLabel = args.apply ? "APPLY (writing changes)" : "DRY RUN"
  const scopeLabel = args.organizationId
    ? `org=${args.organizationId}`
    : "ALL organizations"
  console.log(`\nMigration mode: ${modeLabel}`)
  console.log(`Scope:          ${scopeLabel}`)
  console.log(
    `Rule:           category "${OLD_CATEGORY}" + label matching /other/i AND /deduc/i → "${NEW_CATEGORY}"`,
  )
  console.log()

  const config = getDatabaseConnectionConfig()
  if (!config) throw new Error("Missing MySQL connection variables.")
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
    // ── 1. PayrollProfile.fixedAllowances ─────────────────────────
    const profileWhere = args.organizationId
      ? {
          employeeProfile: {
            organizationId: args.organizationId,
          },
        }
      : {}
    const profiles = await prisma.payrollProfile.findMany({
      where: profileWhere,
      select: {
        id: true,
        fixedAllowances: true,
        employeeProfile: {
          select: {
            employeeId: true,
            organizationId: true,
            user: { select: { name: true } },
          },
        },
      },
    })

    let profilesTouched = 0
    let profileItemsChanged = 0
    for (const p of profiles) {
      const result = migrateItems(p.fixedAllowances)
      if (!result.changed) continue
      profilesTouched += 1
      profileItemsChanged += result.changedCount
      const empName = p.employeeProfile?.user?.name ?? "?"
      const empCode = p.employeeProfile?.employeeId ?? "?"
      const org = p.employeeProfile?.organizationId ?? "?"
      console.log(
        `  [profile] ${empCode}  ${empName}  (org=${org.slice(0, 6)}…) — ${result.changedCount} entry${result.changedCount === 1 ? "" : "ies"}`,
      )
      for (const e of result.changedEntries) {
        console.log(
          `      • "${e.label}"  RM ${e.amount ?? "?"}  →  ${NEW_CATEGORY}`,
        )
      }
      if (args.apply) {
        await prisma.payrollProfile.update({
          where: { id: p.id },
          data: { fixedAllowances: result.next as never },
        })
      }
    }
    console.log(
      `\nPayrollProfile.fixedAllowances: ${profilesTouched} profile(s) affected, ${profileItemsChanged} entry(ies).`,
    )

    // ── 2. PayrollRunAdjustment.manualLineItems (DRAFT runs only) ──
    const adjustmentWhere: {
      payrollRun: { status: "DRAFT"; organizationId?: string }
    } = {
      payrollRun: { status: "DRAFT" },
    }
    if (args.organizationId) {
      adjustmentWhere.payrollRun.organizationId = args.organizationId
    }
    const adjustments = await prisma.payrollRunAdjustment.findMany({
      where: adjustmentWhere,
      select: {
        id: true,
        manualLineItems: true,
        payrollRun: {
          select: {
            id: true,
            periodYear: true,
            periodMonth: true,
            status: true,
          },
        },
        employeeProfile: {
          select: {
            employeeId: true,
            organizationId: true,
            user: { select: { name: true } },
          },
        },
      },
    })

    let adjustmentsTouched = 0
    let adjustmentItemsChanged = 0
    for (const adj of adjustments) {
      const result = migrateItems(adj.manualLineItems)
      if (!result.changed) continue
      adjustmentsTouched += 1
      adjustmentItemsChanged += result.changedCount
      const empName = adj.employeeProfile?.user?.name ?? "?"
      const empCode = adj.employeeProfile?.employeeId ?? "?"
      const yy = adj.payrollRun.periodYear
      const mm = String(adj.payrollRun.periodMonth).padStart(2, "0")
      console.log(
        `  [run adj] ${empCode}  ${empName}  ${yy}-${mm} DRAFT — ${result.changedCount} entry${result.changedCount === 1 ? "" : "ies"}`,
      )
      for (const e of result.changedEntries) {
        console.log(
          `      • "${e.label}"  RM ${e.amount ?? "?"}  →  ${NEW_CATEGORY}`,
        )
      }
      if (args.apply) {
        await prisma.payrollRunAdjustment.update({
          where: { id: adj.id },
          data: { manualLineItems: result.next as never },
        })
      }
    }
    console.log(
      `\nPayrollRunAdjustment.manualLineItems (DRAFT): ${adjustmentsTouched} run-adjustment(s) affected, ${adjustmentItemsChanged} entry(ies).`,
    )

    // ── Summary + next-step notes ─────────────────────────────────
    console.log("\n────────────────────────────────────────────────────")
    console.log("Summary:")
    console.log(`  Profiles updated:            ${profilesTouched}`)
    console.log(`  Profile items reclassified:  ${profileItemsChanged}`)
    console.log(`  Run adjustments updated:     ${adjustmentsTouched}`)
    console.log(`  Adjustment items reclassified: ${adjustmentItemsChanged}`)
    if (!args.apply) {
      console.log(
        "\nThis was a DRY RUN — no writes were made. Re-run with `--apply` to commit.",
      )
    } else {
      console.log("\nWrites committed. Next steps:")
      console.log(
        "  • Re-run any DRAFT payroll runs so their payslips pick up the new category.",
      )
      console.log(
        "  • SUBMITTED runs were NOT touched — their frozen snapshots stand.",
      )
    }
    console.log(
      "\nSkipped by design: PayslipLineItem rows on SUBMITTED payslips. Those",
    )
    console.log(
      "are compliance snapshots and can't be edited without re-running the",
    )
    console.log("calc engine end-to-end.")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
