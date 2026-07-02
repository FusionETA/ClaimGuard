/// One-off: import May 2026 allowances from the Jan–May payroll PDF into
/// the May 2026 PayrollRun's PayrollRunAdjustment.manualLineItems.
///
/// Dry-run by default — prints what would be written without touching the DB.
/// Pass --apply to commit.
///
///   npx tsx scripts/import-may-allowances.ts
///   npx tsx scripts/import-may-allowances.ts --apply
import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

const APPLY = process.argv.includes("--apply")

// ─── PDF-extracted May 2026 allowances ────────────────────────────────────
// Source: "jan to may (2).pdf", parsed 2026-07-02.
// Shape: { empNo, breakdown: { [pdfLabel]: amount } }
// Only employees with at least one non-zero allowance are included.

const PDF_DATA: Array<{ empNo: string; breakdown: Record<string, number> }> = [
  { empNo: "AA0002", breakdown: { "PETROL ALL": 350 } },
  { empNo: "AA0003", breakdown: { "ADD.ALL": 7000, "MV EXP.ALL": 500, "PETROL ALL": 1000 } },
  { empNo: "AA0008", breakdown: { "PETROL ALL": 600 } },
  { empNo: "AA0023", breakdown: { "ADD.ALL": 250, "PETROL ALL": 500 } },
  { empNo: "AA0033", breakdown: { "MV EXP.ALL": 200, "EXP.ALL": 150, "PETROL ALL": 500 } },
  { empNo: "AA0131", breakdown: { "PETROL ALL": 320 } },
  { empNo: "AA0154", breakdown: { "ADD.ALL": 450, "PETROL ALL": 450 } },
  { empNo: "AA0161", breakdown: { "PETROL ALL": 150 } },
  { empNo: "AA0249", breakdown: { "ADD.ALL": 800, "PETROL ALL": 750 } },
  { empNo: "AA0304", breakdown: { "PETROL ALL": 500 } },
  { empNo: "AA0336", breakdown: { "MV EXP.ALL": 250 } },
  { empNo: "AA0354", breakdown: { "PETROL ALL": 300 } },
  { empNo: "AA0359", breakdown: { "PETROL ALL": 300 } },
  { empNo: "AA0417", breakdown: { "PETROL ALL": 600 } },
  { empNo: "AA0474", breakdown: { "PETROL ALL": 300 } },
  { empNo: "AA0514", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 400 } },
  { empNo: "AA0536", breakdown: { "ADD.ALL": 300, "MV EXP.ALL": 200, "PETROL ALL": 700 } },
  { empNo: "AA0556", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 600 } },
  { empNo: "AA0569", breakdown: { "PETROL ALL": 400 } },
  { empNo: "AA0582", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 350 } },
  { empNo: "AA0597", breakdown: { "ADD.ALL": 1500, "MV EXP.ALL": 200, "PETROL ALL": 500 } },
  { empNo: "AA0614", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 500 } },
  { empNo: "AA0620", breakdown: { "PETROL ALL": 500 } },
  { empNo: "AA0625", breakdown: { "MV EXP.ALL": 500, "PETROL ALL": 600 } },
  { empNo: "AA0648", breakdown: { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 } },
  { empNo: "AA0657", breakdown: { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 } },
  { empNo: "AA0676", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0722", breakdown: { "EXP.ALL": 150, "PETROL ALL": 500 } },
  { empNo: "AA0744", breakdown: { "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 } },
  { empNo: "AA0758", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0779", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 1200 } },
  { empNo: "AA0784", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0788", breakdown: { "ADD.ALL": 150, "MV EXP.ALL": 200, "HP EXP.ALL": 50, "PETROL ALL": 300 } },
  { empNo: "AA0790", breakdown: { "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 500 } },
  { empNo: "AA0792", breakdown: { "PETROL ALL": 500 } },
  { empNo: "AA0794", breakdown: { "HOUSE ALL": 500, "MV EXP.ALL": 200, "PETROL ALL": 450 } },
  { empNo: "AA0798", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0804", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 500 } },
  { empNo: "AA0818", breakdown: { "OUT.EXP.ALL": 500, "PETROL ALL": 500 } },
  { empNo: "AA0819", breakdown: { "ADD.ALL": 1000, "PETROL ALL": 400 } },
  { empNo: "AA0836", breakdown: { "MV EXP.ALL": 300, "PETROL ALL": 400 } },
  { empNo: "AA0844", breakdown: { "PETROL ALL": 400 } },
  { empNo: "AA0862", breakdown: { "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0867", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0901", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0908", breakdown: { "PETROL ALL": 400 } },
  { empNo: "AA0909", breakdown: { "ADD.ALL": 150, "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0915", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0924", breakdown: { "PETROL ALL": 250 } },
  { empNo: "AA0949", breakdown: { "PETROL ALL": 300 } },
  { empNo: "AA0955", breakdown: { "PETROL ALL": 300 } },
  { empNo: "AA0961", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0966", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 400 } },
  { empNo: "AA0970", breakdown: { "MV EXP.ALL": 500, "PETROL ALL": 830 } },
  { empNo: "AA0979", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "AA0980", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0985", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "AA0986", breakdown: { "PETROL ALL": 700 } },
  { empNo: "AA0987", breakdown: { "PETROL ALL": 500 } },
  { empNo: "AA0988", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 280 } },
  { empNo: "AA0990", breakdown: { "MV EXP.ALL": 200, "OUT.EXP.ALL": 1500, "PETROL ALL": 300 } },
  { empNo: "AA0992", breakdown: { "PETROL ALL": 200 } },
  { empNo: "AA0994", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 400 } },
  { empNo: "AA0995", breakdown: { "MV EXP.ALL": 150, "PETROL ALL": 150 } },
  { empNo: "AA0996", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "AA0997", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "AA0998", breakdown: { "ADD.ALL": 500, "PETROL ALL": 500 } },
  { empNo: "AA1000", breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E122",   breakdown: { "PETROL ALL": 300 } },
  { empNo: "E142",   breakdown: { "ADD.ALL": 80 } },
  { empNo: "E155",   breakdown: { "PETROL ALL": 300 } },
  { empNo: "E161",   breakdown: { "MV EXP.ALL": 200 } },
  { empNo: "E170",   breakdown: { "ADD.ALL": 150, "MV EXP.ALL": 200, "EXP.ALL": 500, "PETROL ALL": 400 } },
  { empNo: "E175",   breakdown: { "PETROL ALL": 200 } },
  { empNo: "E186",   breakdown: { "PETROL ALL": 500 } },
  { empNo: "E188",   breakdown: { "PETROL ALL": 850 } },
  { empNo: "E189",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E193",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E198",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E200",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E201",   breakdown: { "MV EXP.ALL": 200, "OUT.EXP.ALL": 2000, "PETROL ALL": 200 } },
  { empNo: "E206",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E208",   breakdown: { "MV EXP.ALL": 200, "OUT.EXP.ALL": 500, "PETROL ALL": 300 } },
  { empNo: "E209",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E212",   breakdown: { "PETROL ALL": 300 } },
  { empNo: "E217",   breakdown: { "PETROL ALL": 350 } },
  { empNo: "E220",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E221",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E223",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E224",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E232",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E234",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E235",   breakdown: { "MV EXP.ALL": 100, "PETROL ALL": 100 } },
  { empNo: "E238",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E239",   breakdown: { "MV EXP.ALL": 150, "PETROL ALL": 150 } },
  { empNo: "E247",   breakdown: { "MV EXP.ALL": 300, "PETROL ALL": 200 } },
  { empNo: "E248",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E251",   breakdown: { "MV EXP.ALL": 200, "OUT.EXP.ALL": 1500, "PETROL ALL": 300 } },
  { empNo: "E252",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E257",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E258",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E259",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E260",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E263",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E264",   breakdown: { "ADD.ALL": 500, "PETROL ALL": 500 } },
  { empNo: "E266",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E267",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E268",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E273",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E276",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E277",   breakdown: { "MV EXP.ALL": 100, "PETROL ALL": 200 } },
  { empNo: "E278",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E282",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E289",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E291",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E293",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E296",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 200 } },
  { empNo: "E297",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E306",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E310",   breakdown: { "PETROL ALL": 500 } },
  { empNo: "E313",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E314",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E316",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E317",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E318",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E319",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E320",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E323",   breakdown: { "PETROL ALL": 200 } },
  { empNo: "E325",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E326",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E328",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E329",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E331",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E332",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E333",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E334",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E335",   breakdown: { "PETROL ALL": 300 } },
  { empNo: "E336",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E337",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E338",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E339",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E340",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E343",   breakdown: { "MV EXP.ALL": 200, "OUT.EXP.ALL": 1000, "PETROL ALL": 300 } },
  { empNo: "E344",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E345",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E346",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E347",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E348",   breakdown: { "ADD.ALL": 886 } },
  { empNo: "E350",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E351",   breakdown: { "ADD.ALL": 250, "MV EXP.ALL": 300, "PETROL ALL": 800 } },
  { empNo: "E352",   breakdown: { "MV EXP.ALL": 32.3, "PETROL ALL": 48.4 } },
  { empNo: "E353",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E354",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E355",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E359",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E360",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300, "REFUND": 370.88 } },
  { empNo: "E361",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300, "REFUND": 467.72 } },
  { empNo: "E362",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E363",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E364",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E365",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E366",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E367",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E368",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E369",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E370",   breakdown: { "MV EXP.ALL": 200, "PETROL ALL": 300 } },
  { empNo: "E371",   breakdown: { "HOUSE ALL": 300, "MEAL": 200, "REFUND": 835.32 } },
  { empNo: "E372",   breakdown: { "HP EXP.ALL": 135.66, "PETROL ALL": 203.28 } },
  { empNo: "E373",   breakdown: { "MV EXP.ALL": 90.44, "HP EXP.ALL": 22.68, "PETROL ALL": 135.52 } },
  { empNo: "E374",   breakdown: { "MV EXP.ALL": 90.44, "HP EXP.ALL": 22.68, "PETROL ALL": 135.52 } },
]

// ─── Category mapping ──────────────────────────────────────────────────────
// PETROL ALL + MV EXP.ALL → allowance_travel_private (combined)
// OUT.EXP.ALL              → allowance_travel_official
// ADD.ALL                  → wages_gratuity (treatAsRecurring=true — same amount every month)
// MEAL                     → allowance_meal
// HP EXP.ALL               → allowance_phone_bill
// HOUSE ALL                → bik_living_accommodation
// EXP.ALL                  → allowance_standard
// REFUND                   → wages_expense_claim

type LineItem = {
  kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
  category: string
  label: string
  amount: number
  treatAsRecurring?: boolean
}

function buildLineItems(breakdown: Record<string, number>): LineItem[] {
  // Combine PETROL ALL + MV EXP.ALL into one travel_private line
  const travelPrivate =
    (breakdown["PETROL ALL"] ?? 0) + (breakdown["MV EXP.ALL"] ?? 0)

  const items: LineItem[] = []

  if (travelPrivate > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_private",
      label: "Travel/Petrol Allowance (Private Use/Commuting)",
      amount: Math.round(travelPrivate * 100) / 100,
    })
  }

  const outExp = breakdown["OUT.EXP.ALL"] ?? 0
  if (outExp > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_official",
      label: "Travel Allowance (Official Duties)",
      amount: outExp,
    })
  }

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

  const meal = breakdown["MEAL"] ?? 0
  if (meal > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_meal",
      label: "Meal Allowance",
      amount: meal,
    })
  }

  const phone = breakdown["HP EXP.ALL"] ?? 0
  if (phone > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_phone_bill",
      label: "Phone Bill Allowance",
      amount: Math.round(phone * 100) / 100,
    })
  }

  const house = breakdown["HOUSE ALL"] ?? 0
  if (house > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "bik_living_accommodation",
      label: "Living Accommodation (BIK)",
      amount: house,
    })
  }

  const exp = breakdown["EXP.ALL"] ?? 0
  if (exp > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_standard",
      label: "Expense Allowance",
      amount: exp,
    })
  }

  const refund = breakdown["REFUND"] ?? 0
  if (refund > 0) {
    items.push({
      kind: "REIMBURSEMENT",
      category: "wages_expense_claim",
      label: "Expense Claim Refund",
      amount: Math.round(refund * 100) / 100,
    })
  }

  return items
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const cfg = getDatabaseConnectionConfig()
  if (!cfg) throw new Error("Missing DATABASE_URL env.")

  const adapter = new PrismaMariaDb({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
  })
  const prisma = new PrismaClient({ adapter } as never)

  console.log(APPLY ? "🚀  APPLY mode — writing to DB" : "🔍  DRY RUN — no DB writes\n")

  // Find May 2026 payroll run(s)
  const runs = await prisma.payrollRun.findMany({
    where: { periodYear: 2026, periodMonth: 5 },
    select: { id: true, organizationId: true, status: true },
  })

  if (runs.length === 0) {
    console.error("❌  No PayrollRun found for May 2026. Create the run first in the admin UI.")
    process.exit(1)
  }
  if (runs.length > 1) {
    console.log(`Found ${runs.length} May 2026 runs (multiple orgs):`)
    runs.forEach((r) => console.log(`  ${r.id}  org=${r.organizationId}  status=${r.status}`))
    console.log("\nScript will process all of them. Pass --run-id=<id> to target one (not yet implemented).")
  }

  for (const run of runs) {
    console.log(`\nPayrollRun ${run.id}  org=${run.organizationId}  status=${run.status}`)

    // Load all EmployeeProfiles for this org indexed by employeeId
    const profiles = await prisma.employeeProfile.findMany({
      where: { organizationId: run.organizationId },
      select: { id: true, employeeId: true },
    })
    const profileByEmpNo = new Map(profiles.map((p) => [p.employeeId, p.id]))

    let matched = 0, skipped = 0, created = 0, updated = 0

    for (const row of PDF_DATA) {
      const profileId = profileByEmpNo.get(row.empNo)
      if (!profileId) {
        console.log(`  ⚠️  ${row.empNo} — not found in org ${run.organizationId}, skipping`)
        skipped++
        continue
      }

      const lineItems = buildLineItems(row.breakdown)
      if (lineItems.length === 0) continue

      const total = lineItems.reduce((s, li) => s + li.amount, 0)
      const summary = lineItems.map((li) => `${li.label}: ${li.amount.toFixed(2)}`).join(", ")

      // Check for existing adjustment row
      const existing = await prisma.payrollRunAdjustment.findUnique({
        where: { payrollRunId_employeeProfileId: { payrollRunId: run.id, employeeProfileId: profileId } },
        select: { id: true, manualLineItems: true },
      })

      if (existing) {
        const existingItems = Array.isArray(existing.manualLineItems) ? existing.manualLineItems : []
        const existingTotal = (existingItems as LineItem[]).reduce((s, li) => s + (li.amount ?? 0), 0)
        console.log(`  ${existing ? "✏️ " : "➕"} ${row.empNo}  total=${total.toFixed(2)}  [${summary}]`)
        if (existingTotal > 0) {
          console.log(`    ⚠️  Already has ${existingTotal.toFixed(2)} in manualLineItems — will REPLACE`)
        }
        if (APPLY) {
          await prisma.payrollRunAdjustment.update({
            where: { id: existing.id },
            data: { manualLineItems: lineItems as never, lastMutatedAt: new Date() } as never,
          })
          updated++
        }
      } else {
        console.log(`  ➕ ${row.empNo}  total=${total.toFixed(2)}  [${summary}]`)
        if (APPLY) {
          await prisma.payrollRunAdjustment.create({
            data: {
              payrollRunId: run.id,
              employeeProfileId: profileId,
              otNormalHours: 0,
              otRestHours: 0,
              otPublicHours: 0,
              manualLineItems: lineItems as never,
              fixedAllowanceOverrides: {} as never,
              notes: "Imported from Jan–May 2026 payroll PDF",
            },
          })
          created++
        }
      }

      matched++
    }

    console.log(`\n  Summary: ${matched} matched, ${skipped} not found, ${created} created, ${updated} updated`)
  }

  if (!APPLY) {
    console.log("\n✅  Dry run complete. Run with --apply to write to DB.")
  } else {
    console.log("\n✅  Done.")
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
