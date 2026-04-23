import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { verifyPassword } from "@/lib/auth/password"
import type {
  SessionUser,
} from "@/lib/auth/types"

function buildInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function buildSubtitle(
  role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR",
  profile: { jobTitle: string } | null
) {
  if (role === "ADMIN") {
    return "Administrator"
  }

  if (role === "SUPERVISOR") {
    return profile?.jobTitle ?? "Supervisor"
  }

  return profile?.jobTitle ?? "Employee"
}

export async function authenticateUser({
  email,
  password,
}: {
  email: string
  password: string
}) {
  const normalizedEmail = email.trim().toLowerCase()
  const prisma = getPrismaClient()

  if (!prisma) {
    return {
      success: false as const,
      message: "Database is not configured. Contact your administrator.",
    }
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { employeeProfile: true },
  })

  if (!user) {
    return {
      success: false as const,
      message: "Invalid email or password.",
    }
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return {
      success: false as const,
      message: "Invalid email or password.",
    }
  }

  return {
    success: true as const,
    user: {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      initials: buildInitials(user.name),
      subtitle: buildSubtitle(user.role, user.employeeProfile),
    } satisfies SessionUser,
  }
}
