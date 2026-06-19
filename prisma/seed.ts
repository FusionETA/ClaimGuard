import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"

import { hashPassword } from "../lib/auth/password"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

// ---------------------------------------------------------------------------
// Seed data — creates the initial admin account only.
// Organization is set up through the Settings page after first login.
// ---------------------------------------------------------------------------

const ADMIN = {
  email: "admin@example.com",
  name: "Admin User",
  password: "ChangeMe123!",
}

// OWNER behaves like an admin everywhere, but is the ONLY role that can
// add/remove admins. Owners are created here (seed) or via the master
// API — never through the in-app UI.
const OWNER = {
  email: "owner@example.com",
  name: "Owner User",
  password: "ChangeMe123!",
}

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

  // Seed admin + owner — manual find-or-create because email is no
  // longer DB-unique (Prisma's upsert requires a unique where-key).
  await seedUserByEmail(prisma, {
    email: ADMIN.email,
    name: ADMIN.name,
    role: "ADMIN",
    passwordHash: hashPassword(ADMIN.password),
  })
  await seedUserByEmail(prisma, {
    email: OWNER.email,
    name: OWNER.name,
    role: "OWNER",
    passwordHash: hashPassword(OWNER.password),
  })

  await prisma.$disconnect()
  console.log("Seed complete. Log in with:", ADMIN.email, "or", OWNER.email)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

/**
 * Manual find-or-create for seeding. Prisma's `upsert` requires a
 * unique where-key, and `email` is no longer @unique on User. We
 * still want idempotent seeding (re-run shouldn't duplicate rows),
 * so look up by email + update-or-create explicitly.
 */
async function seedUserByEmail(
  prisma: PrismaClient,
  data: {
    email: string
    name: string
    role: "OWNER" | "ADMIN" | "EMPLOYEE" | "SUPERVISOR"
    passwordHash: string
  },
) {
  const existing = await prisma.user.findFirst({
    where: { email: data.email },
    select: { id: true },
  })
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        role: data.role,
        passwordHash: data.passwordHash,
      },
    })
  } else {
    await prisma.user.create({ data })
  }
}
