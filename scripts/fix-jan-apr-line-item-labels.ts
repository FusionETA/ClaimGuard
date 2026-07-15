/// One-off: re-map manualLineItems in Jan–Apr 2026 PayrollRun adjustments to
/// use the correct UBS Category → AltomateHR labels per the agreed mapping.
///
/// The original import (import-jan-apr-allowances.ts) combined PETROL ALL +
/// MV EXP.ALL into a single "Travel/Petrol Allowance (Private Use/Commuting)"
/// line. The correct mapping has both as "Travel/Petrol/Toll (Official Duty)",
/// so this script splits them back out and applies all label corrections.
///
/// Dry-run by default — prints what would change without touching the DB.
/// Pass --apply to commit. Pass --month=N to process only that month (1–4).
///
///   npx tsx scripts/fix-jan-apr-line-item-labels.ts
///   npx tsx scripts/fix-jan-apr-line-item-labels.ts --month=1
///   npx tsx scripts/fix-jan-apr-line-item-labels.ts --month=1 --apply
import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

const APPLY = process.argv.includes("--apply")
const MONTH_ARG = process.argv.find((a) => a.startsWith("--month="))
const ONLY_MONTH = MONTH_ARG ? parseInt(MONTH_ARG.split("=")[1]!) : null

// ─── PDF source data (same as import-jan-apr-allowances.ts) ──────────────────
// monthly[0]=Jan, monthly[1]=Feb, monthly[2]=Mar, monthly[3]=Apr.

const PDF_DATA: Array<{ empNo: string; monthly: Array<Record<string, number>> }> = [
  { empNo: "AA0002", monthly: [{ "PETROL ALL": 350 }, { "PETROL ALL": 350 }, { "PETROL ALL": 350 }, { "PETROL ALL": 350 }] },
  { empNo: "AA0003", monthly: [{ "ADD.ALL": 7000, "MV EXP.ALL": 500, "PETROL ALL": 1000 }, { "ADD.ALL": 7000, "MV EXP.ALL": 500, "PETROL ALL": 1000 }, { "ADD.ALL": 7000, "MV EXP.ALL": 500, "PETROL ALL": 1000 }, { "ADD.ALL": 7000, "MV EXP.ALL": 500, "PETROL ALL": 1000 }] },
  { empNo: "AA0008", monthly: [{ "PETROL ALL": 600 }, { "PETROL ALL": 600 }, { "PETROL ALL": 600 }, { "PETROL ALL": 600 }] },
  { empNo: "AA0023", monthly: [{ "ADD.ALL": 250, "PETROL ALL": 500 }, { "ADD.ALL": 250, "PETROL ALL": 500 }, { "ADD.ALL": 250, "PETROL ALL": 500 }, { "ADD.ALL": 250, "PETROL ALL": 500 }] },
  { empNo: "AA0033", monthly: [{ "MV EXP.ALL": 200, "EXP.ALL": 150, "PETROL ALL": 500 }, { "MV EXP.ALL": 200, "EXP.ALL": 150, "PETROL ALL": 500 }, { "MV EXP.ALL": 200, "EXP.ALL": 150, "PETROL ALL": 500 }, { "MV EXP.ALL": 200, "EXP.ALL": 150, "PETROL ALL": 500 }] },
  { empNo: "AA0131", monthly: [{ "PETROL ALL": 320 }, { "PETROL ALL": 320 }, { "PETROL ALL": 320 }, { "PETROL ALL": 320 }] },
  { empNo: "AA0154", monthly: [{ "ADD.ALL": 450, "PETROL ALL": 450 }, { "ADD.ALL": 450, "PETROL ALL": 450 }, { "ADD.ALL": 450, "PETROL ALL": 450 }, { "ADD.ALL": 450, "PETROL ALL": 450 }] },
  { empNo: "AA0161", monthly: [{ "PETROL ALL": 150 }, { "PETROL ALL": 150 }, { "PETROL ALL": 150 }, { "PETROL ALL": 150 }] },
  { empNo: "AA0249", monthly: [{ "ADD.ALL": 800, "PETROL ALL": 750 }, { "ADD.ALL": 800, "PETROL ALL": 750 }, { "ADD.ALL": 800, "PETROL ALL": 750 }, { "ADD.ALL": 800, "PETROL ALL": 750 }] },
  { empNo: "AA0304", monthly: [{ "PETROL ALL": 500 }, { "PETROL ALL": 500 }, { "PETROL ALL": 500 }, { "PETROL ALL": 500 }] },
  { empNo: "AA0336", monthly: [{ "MV EXP.ALL": 250 }, { "MV EXP.ALL": 250 }, { "MV EXP.ALL": 250 }, { "MV EXP.ALL": 250 }] },
  { empNo: "AA0354", monthly: [{ "PETROL ALL": 300 }, { "PETROL ALL": 300 }, { "PETROL ALL": 300 }, { "PETROL ALL": 300 }] },
  { empNo: "AA0359", monthly: [{ "PETROL ALL": 300 }, { "PETROL ALL": 300 }, { "PETROL ALL": 300 }, { "PETROL ALL": 300 }] },
  { empNo: "AA0417", monthly: [{ "PETROL ALL": 600 }, { "PETROL ALL": 600 }, { "PETROL ALL": 600 }, { "PETROL ALL": 600 }] },
  { empNo: "AA0474", monthly: [{ "PETROL ALL": 300 }, { "PETROL ALL": 300 }, { "PETROL ALL": 300 }, { "PETROL ALL": 300 }] },
  { empNo: "AA0514", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 400 }, { "MV EXP.ALL": 200, "PETROL ALL": 400 }, { "MV EXP.ALL": 200, "PETROL ALL": 400 }, { "MV EXP.ALL": 200, "PETROL ALL": 400 }] },
  { empNo: "AA0536", monthly: [{ "ADD.ALL": 300, "MV EXP.ALL": 200, "PETROL ALL": 700 }, { "ADD.ALL": 300, "MV EXP.ALL": 200, "PETROL ALL": 700 }, { "ADD.ALL": 300, "MV EXP.ALL": 200, "PETROL ALL": 700 }, { "ADD.ALL": 300, "MV EXP.ALL": 200, "PETROL ALL": 700 }] },
  { empNo: "AA0556", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 600 }, { "MV EXP.ALL": 200, "PETROL ALL": 600 }, { "MV EXP.ALL": 200, "PETROL ALL": 600 }, { "MV EXP.ALL": 200, "PETROL ALL": 600 }] },
  { empNo: "AA0569", monthly: [{ "PETROL ALL": 400 }, { "PETROL ALL": 400 }, { "PETROL ALL": 400 }, { "PETROL ALL": 400 }] },
  { empNo: "AA0582", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 350 }, { "MV EXP.ALL": 200, "PETROL ALL": 350 }, { "MV EXP.ALL": 200, "PETROL ALL": 350 }, { "MV EXP.ALL": 200, "PETROL ALL": 350 }] },
  { empNo: "AA0597", monthly: [{ "ADD.ALL": 1500, "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "ADD.ALL": 1500, "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "ADD.ALL": 1500, "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "ADD.ALL": 1500, "MV EXP.ALL": 200, "PETROL ALL": 500 }] },
  { empNo: "AA0614", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "MV EXP.ALL": 200, "PETROL ALL": 500 }] },
  { empNo: "AA0620", monthly: [{ "PETROL ALL": 500 }, { "PETROL ALL": 500 }, { "PETROL ALL": 500 }, { "PETROL ALL": 500 }] },
  { empNo: "AA0625", monthly: [{ "MV EXP.ALL": 500, "PETROL ALL": 600 }, { "MV EXP.ALL": 500, "PETROL ALL": 600 }, { "MV EXP.ALL": 500, "PETROL ALL": 600 }, { "MV EXP.ALL": 500, "PETROL ALL": 600 }] },
  { empNo: "AA0648", monthly: [{ "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }] },
  { empNo: "AA0657", monthly: [{ "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }] },
  { empNo: "AA0676", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }] },
  { empNo: "AA0722", monthly: [{ "EXP.ALL": 150, "PETROL ALL": 500 }, { "EXP.ALL": 150, "PETROL ALL": 500 }, { "EXP.ALL": 150, "PETROL ALL": 500 }, { "EXP.ALL": 150, "PETROL ALL": 500 }] },
  { empNo: "AA0744", monthly: [{ "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }] },
  { empNo: "AA0758", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }] },
  { empNo: "AA0779", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 1200 }, { "MV EXP.ALL": 200, "PETROL ALL": 1200 }, { "MV EXP.ALL": 200, "PETROL ALL": 1200 }, { "MV EXP.ALL": 200, "PETROL ALL": 1200 }] },
  { empNo: "AA0784", monthly: [{ "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }, { "MV EXP.ALL": 200, "PETROL ALL": 300 }] },
  { empNo: "AA0788", monthly: [{ "ADD.ALL": 150, "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "ADD.ALL": 150, "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "ADD.ALL": 150, "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }, { "ADD.ALL": 150, "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 }] },
  { empNo: "AA0790", monthly: [{ "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 500 }, { "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 500 }] },
]

// ─── UBS Category → AltomateHR line item mapping ─────────────────────────────

type LineItem = {
  kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
  category: string | null
  label: string
  amount: number
  treatAsRecurring?: boolean
}

function buildLineItems(breakdown: Record<string, number>): LineItem[] {
  const items: LineItem[] = []

  // ADD.ALL → Gratuity
  const addAll = breakdown["ADD.ALL"] ?? 0
  if (addAll > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "wages_gratuity",
      label: "Gratuity",
      amount: addAll,
      treatAsRecurring: true,
    })
  }

  // HOUSE ALL → Standard Allowance
  const house = breakdown["HOUSE ALL"] ?? 0
  if (house > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_standard",
      label: "Standard Allowance",
      amount: house,
    })
  }

  // MV EXP.ALL → Travel/Petrol/Toll (Official Duty)
  const mvExp = breakdown["MV EXP.ALL"] ?? 0
  if (mvExp > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_official",
      label: "Travel/Petrol/Toll (Official Duty)",
      amount: mvExp,
    })
  }

  // HP EXP.ALL → Phone Allowance (Fixed)
  const phone = breakdown["HP EXP.ALL"] ?? 0
  if (phone > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_phone_fixed",
      label: "Phone Allowance (Fixed)",
      amount: phone,
    })
  }

  // PETROL ALL → Travel/Petrol/Toll (Official Duty)
  const petrol = breakdown["PETROL ALL"] ?? 0
  if (petrol > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_official",
      label: "Travel/Petrol/Toll (Official Duty)",
      amount: petrol,
    })
  }

  // MEAL → Meal Allowance
  const meal = breakdown["MEAL"] ?? 0
  if (meal > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_meal",
      label: "Meal Allowance",
      amount: meal,
    })
  }

  // EXP.ALL → Standard Allowance / Expense Claim
  const exp = breakdown["EXP.ALL"] ?? 0
  if (exp > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_standard",
      label: "Standard Allowance",
      amount: exp,
    })
  }

  // OUT.EXP.ALL → Expense Claim
  const outExp = breakdown["OUT.EXP.ALL"] ?? 0
  if (outExp > 0) {
    items.push({
      kind: "REIMBURSEMENT",
      category: "wages_expense_claim",
      label: "Expense Claim",
      amount: outExp,
    })
  }

  // REFUND → Miscellaneous / Other Deduction
  const refund = breakdown["REFUND"] ?? 0
  if (refund > 0) {
    items.push({
      kind: "DEDUCTION",
      category: "deduct_miscellaneous",
      label: "Miscellaneous / Other Deduction",
      amount: Math.round(refund * 100) / 100,
    })
  }

  return items
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = getDatabaseConnectionConfig()!
  const adapter = new PrismaMariaDb({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
  })
  const prisma = new PrismaClient({ adapter } as never)

  const monthsToProcess = ONLY_MONTH ? [ONLY_MONTH] : [1, 2, 3, 4]

  console.log(APPLY ? "🚀  APPLY mode — writing to DB" : "🔍  DRY RUN — no DB writes")
  console.log(`Months: ${monthsToProcess.join(", ")}\n`)

  for (const monthNum of monthsToProcess) {
    const monthIdx = monthNum - 1
    const monthName = ["January", "February", "March", "April"][monthIdx]!

    const runs = await prisma.payrollRun.findMany({
      where: { periodYear: 2026, periodMonth: monthNum },
      select: { id: true, organizationId: true, status: true },
    })

    if (runs.length === 0) {
      console.log(`⚠️  No PayrollRun found for ${monthName} 2026 — skipping`)
      continue
    }

    for (const run of runs) {
      console.log(`\n── ${monthName} 2026  run=${run.id}  org=${run.organizationId}  status=${run.status}`)

      const profiles = await prisma.employeeProfile.findMany({
        where: { organizationId: run.organizationId },
        select: { id: true, employeeId: true },
      })
      const profileByEmpNo = new Map(profiles.map((p) => [p.employeeId, p.id]))

      let updated = 0, skipped = 0, noRecord = 0

      for (const row of PDF_DATA) {
        const breakdown = row.monthly[monthIdx] ?? {}
        const newItems = buildLineItems(breakdown)
        if (newItems.length === 0) continue

        const profileId = profileByEmpNo.get(row.empNo)
        if (!profileId) {
          skipped++
          continue
        }

        const existing = await prisma.payrollRunAdjustment.findUnique({
          where: {
            payrollRunId_employeeProfileId: {
              payrollRunId: run.id,
              employeeProfileId: profileId,
            },
          },
          select: { id: true, manualLineItems: true },
        })

        if (!existing) {
          console.log(`  ⚠️  ${row.empNo} — no PayrollRunAdjustment found, skipping`)
          noRecord++
          continue
        }

        const oldItems = (Array.isArray(existing.manualLineItems) ? existing.manualLineItems : []) as LineItem[]

        // Preserve any manually-added DEDUCTION items (e.g. Zakat, Loan Repayment)
        // that were not imported from the PDF — only replace ALLOWANCE/REIMBURSEMENT items.
        const preservedDeductions = oldItems.filter((li) => li.kind === "DEDUCTION")
        const mergedItems = [...newItems, ...preservedDeductions]

        const oldSummary = oldItems.map((li) => `${li.label}: ${li.amount}`).join(", ")
        const newSummary = mergedItems.map((li) => `${li.label}: ${li.amount}`).join(", ")

        console.log(`  ${row.empNo}`)
        console.log(`    OLD: ${oldSummary || "(empty)"}`)
        console.log(`    NEW: ${newSummary}`)
        if (preservedDeductions.length > 0) {
          console.log(`    KEPT: ${preservedDeductions.map((li) => `${li.label}: ${li.amount}`).join(", ")}`)
        }

        if (APPLY) {
          await prisma.payrollRunAdjustment.update({
            where: { id: existing.id },
            data: { manualLineItems: mergedItems as never, lastMutatedAt: new Date() } as never,
          })
        }

        updated++
      }

      console.log(`\n  Summary: ${updated} updated, ${skipped} emp not found, ${noRecord} no adjustment record`)
    }
  }

  if (!APPLY) {
    console.log("\n✅  Dry run complete — no changes written.")
    console.log("    Add --apply to write. Use --month=1 to do January first.")
  } else {
    console.log("\n✅  Done.")
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
