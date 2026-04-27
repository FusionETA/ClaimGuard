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

  // Upsert admin — no organization assigned yet
  await prisma.user.upsert({
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

  await prisma.$disconnect()
  console.log("Seed complete. Log in with:", ADMIN.email)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
