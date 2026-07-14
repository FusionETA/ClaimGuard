import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"
import { hashPassword } from "../lib/auth/password"

/**
 * One-off backfill for the "Jun Timesheet Sample" ABM staff.
 *
 * Purpose
 * =======
 * The client sent a June timesheet Excel with staff spread across
 * multiple client entities (ABSA, ABM, ABSB, ABAP, ABPJ). This script
 * seeds only the ABM subset (9 distinct people) into ONE AltomateHR
 * organization so we can test the payroll-adjustment XLSX import
 * against real names + salaries without polluting the whole client
 * chart.
 *
 * How to use
 * ==========
 * 1. Fill in ORGANIZATION_ID below — the AltomateHR org id you want
 *    these 9 employees seeded into. Grab it from the org dropdown in
 *    the admin UI or from `SELECT id, name FROM Organization`.
 * 2. Adjust the other constants below if you don't like the defaults
 *    (email domain, temp password, join date, job title).
 * 3. Run: `npx tsx prisma/backfill-abm-timesheet-sample.ts`
 * 4. Optionally: upload `~/Downloads/ABM-Jun-Adjustments.xlsx` into
 *    the June draft run's payroll-adjustment import to populate all
 *    the line items (Travelling / Meal / Parking / OT / Comm /
 *    Deduction) from the timesheet.
 *
 * The script is idempotent — re-running skips users whose email
 * already exists.
 */

// ─── FILL THESE IN ────────────────────────────────────────────────────

const ORGANIZATION_ID = "REPLACE_WITH_ORG_ID"
const EMAIL_DOMAIN = "abm.test"
const DEFAULT_PASSWORD = "TempPass2026!"
const JOIN_DATE = new Date("2026-06-01")
const DEFAULT_JOB_TITLE = "Staff"

// ─── ABM staff from the June timesheet ────────────────────────────────
//
// Salaries here are the MONTHLY BASE. Anything that's NOT the base
// (Travelling, Meal, Parking, OT, Commission, Bonus, Deduction) flows
// through the adjustment XLSX — not this script.
//
// For staff whose timesheet had TWO rows split across outlets (Fally,
// AH FU, Nik, Moon), the base salary here is the SUM of both rows'
// Basic column so the person ends up on their correct full monthly
// figure. The per-outlet split becomes the admin's problem to record
// via cost-allocation later if they need it.

type SeedStaff = {
  /// Used verbatim as `User.name`. MUST match the "Full Name" column
  /// in the adjustments XLSX so the importer can bind lines to the
  /// right person.
  name: string
  /// Local part of the email; combined with EMAIL_DOMAIN above.
  emailLocal: string
  /// Org-specific employee code shown on the Manage Employee list.
  employeeId: string
  /// Base monthly salary in MYR.
  monthlySalary: number
  /// Job title. Defaults to DEFAULT_JOB_TITLE if omitted.
  jobTitle?: string
}

const ABM_STAFF: SeedStaff[] = [
  { name: "JEFF", emailLocal: "jeff", employeeId: "ABM-001", monthlySalary: 2050 },
  { name: "Dudu", emailLocal: "dudu", employeeId: "ABM-002", monthlySalary: 2050 },
  { name: "ATIKA", emailLocal: "atika", employeeId: "ABM-003", monthlySalary: 1850 },
  { name: "AMELIA", emailLocal: "amelia", employeeId: "ABM-004", monthlySalary: 1800 },
  { name: "Fally", emailLocal: "fally", employeeId: "ABM-005", monthlySalary: 1800 },
  { name: "AH FU", emailLocal: "ahfu", employeeId: "ABM-006", monthlySalary: 2050 },
  { name: "Eddy", emailLocal: "eddy", employeeId: "ABM-007", monthlySalary: 1800 },
  { name: "Nik", emailLocal: "nik", employeeId: "ABM-008", monthlySalary: 2000 },
  { name: "Moon", emailLocal: "moon", employeeId: "ABM-009", monthlySalary: 2000 },
]

// ─── Runner ───────────────────────────────────────────────────────────

async function main() {
  if (ORGANIZATION_ID === "REPLACE_WITH_ORG_ID") {
    throw new Error(
      "Set ORGANIZATION_ID at the top of this file before running. " +
        "You can find it from SELECT id, name FROM Organization.",
    )
  }

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
    const org = await prisma.organization.findUnique({
      where: { id: ORGANIZATION_ID },
      select: { id: true, name: true },
    })
    if (!org) {
      throw new Error(
        `Organization ${ORGANIZATION_ID} not found. Double-check the id.`,
      )
    }

    console.log(
      `[abm-timesheet] seeding ${ABM_STAFF.length} employees into "${org.name}"`,
    )

    const passwordHash = hashPassword(DEFAULT_PASSWORD)

    let created = 0
    let skipped = 0

    for (const staff of ABM_STAFF) {
      const email = `${staff.emailLocal}@${EMAIL_DOMAIN}`.toLowerCase()

      const existing = await prisma.user.findFirst({
        where: { email },
        select: { id: true, name: true },
      })
      if (existing) {
        console.log(`  · SKIP ${staff.name} — user ${email} already exists`)
        skipped += 1
        continue
      }

      // Create everything the hire path creates: User → EmployeeProfile
      // → PayrollProfile → EmployeeOrganization → initial EmploymentStint.
      // Not wrapped in $transaction here because Prisma+MariaDB's adapter
      // in a backfill context doesn't share a connection across nested
      // ops; the script is idempotent on rerun so partial writes are
      // recoverable.
      const user = await prisma.user.create({
        data: {
          name: staff.name,
          email,
          passwordHash,
          role: "EMPLOYEE",
          organizationId: org.id,
          employeeProfiles: {
            create: {
              organizationId: org.id,
              employeeId: staff.employeeId,
              jobTitle: staff.jobTitle ?? DEFAULT_JOB_TITLE,
              preferredCurrency: "MYR",
              payrollProfile: {
                create: {
                  salaryType: "MONTHLY",
                  monthlySalary: staff.monthlySalary,
                  joinDate: JOIN_DATE,
                  payrollDocuments: [],
                  // Malaysian statutory defaults — flip these in the UI
                  // for individual employees if they differ (e.g. foreign
                  // worker with no EPF).
                  nationality: "Malaysian",
                  isResident: true,
                  hasPr: false,
                  contributeToEpf: true,
                  contributeToEis: true,
                  // paymentMethod default: bank transfer.
                  paymentMethod: "BANK_TRANSFER",
                },
              },
            },
          },
        },
        select: { id: true, employeeProfiles: { select: { id: true } } },
      })

      const employeeProfileId = user.employeeProfiles[0]?.id
      if (!employeeProfileId) {
        throw new Error(`Failed to create employee profile for ${staff.name}`)
      }

      // Multi-org membership row — surfaces the employee on the
      // company-picker + drives the active-org resolver.
      await prisma.employeeOrganization.create({
        data: {
          userId: user.id,
          employeeProfileId,
          organizationId: org.id,
        },
      })

      // Initial employment stint — required by the run engine's
      // period-window filter (post-stint rollout).
      await prisma.employmentStint.create({
        data: {
          employeeProfileId,
          joinDate: JOIN_DATE,
          startReason: "Seeded from Jun timesheet sample",
        },
      })

      console.log(`  ✓ CREATE ${staff.name} <${email}> — RM ${staff.monthlySalary}/mo`)
      created += 1
    }

    console.log(
      `[abm-timesheet] done — created=${created} skipped=${skipped}. ` +
        `Now upload ~/Downloads/ABM-Jun-Adjustments.xlsx into the June ` +
        `draft run's Adjustment Import to populate the line items.`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error("[abm-timesheet] failed", err)
  process.exit(1)
})
