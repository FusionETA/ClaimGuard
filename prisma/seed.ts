import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { hashPassword } from "../lib/auth/password"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"
import { ClaimCategory, ClaimStatus } from "../generated/prisma/enums"

// ---------------------------------------------------------------------------
// Seed data — update these to match your real users before running.
// Change passwords immediately after seeding in production.
// ---------------------------------------------------------------------------

const ADMIN = {
  email: "admin@example.com",
  name: "Admin User",
  password: "ChangeMe123!",
  role: "Administrator",
}

const EMPLOYEES = [
  {
    email: "employee1@example.com",
    name: "Employee One",
    password: "ChangeMe123!",
    employeeId: "EMP-001",
    project: "Engineering Platform",
    jobTitle: "Software Engineer",
    payoutMethod: null,
    preferredCurrency: "USD",
  },
]

// Sample claims to pre-populate the queue (optional — remove if you prefer a clean slate).
const SAMPLE_CLAIMS = [
  {
    claimNumber: "CLM-00001",
    title: "Sample Travel Claim",
    description: "Sample claim created during database seeding.",
    category: ClaimCategory.TRAVEL,
    amount: "100.00",
    currency: "USD",
    spentAt: new Date("2026-01-15"),
    submittedAt: new Date("2026-01-16"),
    status: ClaimStatus.PENDING,
    reviewNotes: null,
    employeeEmail: "employee1@example.com",
  },
]

// ---------------------------------------------------------------------------

async function main() {
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
    connectionLimit: 5,
  })

  const prisma = new PrismaClient({ adapter })

  // Upsert admin
  const admin = await prisma.user.upsert({
    where: { email: ADMIN.email },
    update: {
      name: ADMIN.name,
      role: "ADMIN",
      passwordHash: hashPassword(ADMIN.password),
    },
    create: {
      email: ADMIN.email,
      name: ADMIN.name,
      role: "ADMIN",
      passwordHash: hashPassword(ADMIN.password),
    },
  })

  // Upsert employees
  for (const employee of EMPLOYEES) {
    await prisma.user.upsert({
      where: { email: employee.email },
      update: {
        name: employee.name,
        role: "EMPLOYEE",
        passwordHash: hashPassword(employee.password),
      },
      create: {
        email: employee.email,
        name: employee.name,
        role: "EMPLOYEE",
        passwordHash: hashPassword(employee.password),
        employeeProfile: {
          create: {
            employeeId: employee.employeeId,
            project: employee.project,
            jobTitle: employee.jobTitle,
            payoutMethod: employee.payoutMethod,
            preferredCurrency: employee.preferredCurrency,
          },
        },
      },
    })
  }

  // Upsert sample claims
  const users = await prisma.user.findMany()

  for (const claim of SAMPLE_CLAIMS) {
    const employee = users.find((u) => u.email === claim.employeeEmail)

    if (!employee) {
      console.warn(`Skipping claim ${claim.claimNumber}: employee ${claim.employeeEmail} not found.`)
      continue
    }

    await prisma.claim.upsert({
      where: { claimNumber: claim.claimNumber },
      update: {
        title: claim.title,
        description: claim.description,
        category: claim.category,
        amount: claim.amount,
        currency: claim.currency,
        spentAt: claim.spentAt,
        submittedAt: claim.submittedAt,
        status: claim.status,
        reviewNotes: claim.reviewNotes,
        reviewerId: admin.id,
      },
      create: {
        claimNumber: claim.claimNumber,
        title: claim.title,
        description: claim.description,
        category: claim.category,
        amount: claim.amount,
        currency: claim.currency,
        spentAt: claim.spentAt,
        submittedAt: claim.submittedAt,
        status: claim.status,
        reviewNotes: claim.reviewNotes,
        reviewerId: admin.id,
        employeeId: employee.id,
      },
    })
  }

  await prisma.$disconnect()
  console.log("Seed complete.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
